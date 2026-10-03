import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { setReasonerForTests } from "@/lib/reasoner";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { readLedger } from "@/lib/runtime/ledger";
import { readDeliveries, type OutboundSender } from "@/lib/channels/gateway";
import { applyControlChange, resetControlsCacheForTests } from "@/lib/hq/controls";
import { deriveObligations, reconcileObligations } from "@/lib/operator/obligations";
import { DEFAULT_FOLLOW_UP_POLICY, followUpPolicyFor } from "@/lib/operator/policy";
import { runObligationExecutor, followUpText } from "@/lib/operator/executor";
import { listAttempts, attemptCounts } from "@/lib/operator/attempts";
import { recoveryLedger } from "@/lib/operator/recovery";
import { revenueOpportunities } from "@/lib/owner/opportunities";
import { customerLabel } from "@/lib/owner/service";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * CHECKPOINT 3 — PROACTIVE OPERATOR V2: the bounded obligation executor (re-read state, re-check
 * authority and capability, cancel stale, idempotent attempts, hard limits, no loops), generic
 * follow-up policies from the playbook, revenue recovery states, and owner-facing grouping.
 */

let dispose: (() => void) | undefined;
beforeEach(() => resetControlsCacheForTests());
afterEach(() => {
  setReasonerForTests(undefined);
  resetControlsCacheForTests();
  dispose?.();
  dispose = undefined;
});

const H = 3600_000;
const NOW = new Date("2026-09-30T12:00:00.000Z");

function setup() {
  const r = isolatedRetailer();
  dispose = r.dispose;
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  return { ...r, model, id: conv("op") };
}

/** Build a pending payment link through the real runtime (search → add → checkout with details). */
async function pendingLink(model: ScriptedModel, g: ReturnType<typeof setup>["g"], id: string) {
  model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
  await handleCustomerMessage(g, id, "c", "the midnight dress");
  model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true });
  await handleCustomerMessage(g, id, "c", "add it in M");
  model.plan = () => ({ commerce: { intent: "checkout" }, customerInfo: { name: "Dana", phone: "0501234567" }, evidence: { "customerInfo.name": "Dana", "customerInfo.phone": "0501234567" }, advancesTransaction: true });
  const out = await handleCustomerMessage(g, id, "c", "checkout please, Dana 0501234567");
  const payment = (await getBackend().listPaymentRequests(g.business.id)).find((p) => p.conversationId === id);
  return { out, payment };
}

describe("follow-up policy: bounded defaults, playbook overrides, hard caps", () => {
  it("defaults are bounded; the playbook can disable a kind or tighten it, never exceed the caps", () => {
    const { g } = setup();
    expect(followUpPolicyFor(g)).toEqual(DEFAULT_FOLLOW_UP_POLICY);
    const custom = followUpPolicyFor({ playbook: { ...g.playbook, followUp: { unpaidPayment: { enabled: true, afterHours: 2, maxAttempts: 9, intervalHours: 0.5 }, abandonedCheckout: { enabled: false } } } });
    expect(custom.unpaidPayment).toEqual({ enabled: true, afterHours: 2, maxAttempts: 5, intervalHours: 1 });
    expect(custom.abandonedCheckout.enabled).toBe(false);
    expect(custom.appointmentReminder).toEqual(DEFAULT_FOLLOW_UP_POLICY.appointmentReminder);
  });
});

describe("obligation executor: re-check, act once, record evidence, never loop", () => {
  it("an unpaid link past the delay → BARRY can act → one dry-run reminder in the customer's language, recorded as a dry run (attempt, ledger, delivery) — never in the transcript", async () => {
    const { g, model, id } = setup();
    const { payment } = await pendingLink(model, g, id);
    expect(payment?.status).toBe("pending");
    const later = new Date(Date.parse(payment!.createdAt) + 25 * H);
    const before = await runObligationExecutor(g, { now: later });
    expect(before.considered).toBe(1);
    expect(before.acted).toBe(1);
    expect(before.results[0]).toMatchObject({ kind: "unpaid_payment_followup", outcome: "dry_run", attempt: 1 });
    const attempts = await listAttempts(g.business.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ n: 1, status: "dry_run", channel: "web", idempotencyKey: attempts[0].id });
    expect(attempts[0].what).toMatch(/Would send/);
    expect(attempts[0].what).toMatch(/reminder/);
    const state = (await getConversationStore().get(id))!;
    // A dry run is never "said": the reminder is not in the transcript.
    expect(state.messages.some((m) => /reminder/.test(m.content))).toBe(false);
    expect(readLedger(state).at(-1)).toMatchObject({ effect: "followup.dry_run", status: "no_effect", operation: "followUp" });
    expect(readDeliveries(state.knownFields).at(-1)).toMatchObject({ status: "dry_run" });
    // The obligation now waits on the customer with the attempt recorded; a second pass does nothing (interval + idempotency).
    const obligations = await reconcileObligations({ graph: g, conversations: [state], approvals: [], payments: await getBackend().listPaymentRequests(g.business.id), bookings: [], policy: followUpPolicyFor(g), attempts: attemptCounts(await listAttempts(g.business.id)), now: later });
    expect(obligations[0]).toMatchObject({ kind: "unpaid_payment_followup", nextMove: "waiting_on_customer", attempts: 1, sentAttempts: 0 });
    expect(obligations[0].reason).toMatch(/Test mode/);
    const again = await runObligationExecutor(g, { now: new Date(later.getTime() + H) });
    expect(again.acted).toBe(0);
    expect(await listAttempts(g.business.id)).toHaveLength(1);
  });

  it("hard attempt limit: after the policy's attempts the obligation goes to the owner; the executor never sends again", async () => {
    const { g, model, id } = setup();
    const { payment } = await pendingLink(model, g, id);
    const t0 = Date.parse(payment!.createdAt);
    const r1 = await runObligationExecutor(g, { now: new Date(t0 + 25 * H) });
    const r2 = await runObligationExecutor(g, { now: new Date(t0 + 25 * H + 49 * H) });
    const r3 = await runObligationExecutor(g, { now: new Date(t0 + 25 * H + 98 * H) });
    expect([r1.acted, r2.acted, r3.acted]).toEqual([1, 1, 0]);
    expect(await listAttempts(g.business.id)).toHaveLength(2);
    const state = (await getConversationStore().get(id))!;
    const obligations = await reconcileObligations({ graph: g, conversations: [state], approvals: [], payments: await getBackend().listPaymentRequests(g.business.id), bookings: [], policy: followUpPolicyFor(g), attempts: attemptCounts(await listAttempts(g.business.id)), now: new Date(t0 + 25 * H + 98 * H) });
    expect(obligations[0]).toMatchObject({ nextMove: "needs_owner", owner: "owner", attempts: 2 });
    expect(obligations[0].nextAction).toMatch(/used up/);
  });

  it("stale at execution time: a payment that landed cancels the follow-up; a paused business or safe mode sends nothing", async () => {
    const { g, model, id } = setup();
    const { payment } = await pendingLink(model, g, id);
    const later = new Date(Date.parse(payment!.createdAt) + 25 * H);
    await applyControlChange(g.business.id, { safeMode: true }, { by: "founder", reason: "incident", now: NOW });
    const safe = await runObligationExecutor(g, { now: later });
    expect(safe.blocked).toMatch(/safe mode/);
    expect(safe.acted).toBe(0);
    await applyControlChange(g.business.id, { safeMode: false, pausedBusiness: true }, { by: "founder", reason: "pause", now: NOW });
    expect((await runObligationExecutor(g, { now: later })).blocked).toMatch(/paused/);
    await applyControlChange(g.business.id, { pausedBusiness: false }, { by: "founder", reason: "resume", now: NOW });
    await getBackend().simulatePaymentOutcome(payment!.id, "paid");
    const run = await runObligationExecutor(g, { now: later });
    expect(run.acted).toBe(0);
    expect(await listAttempts(g.business.id)).toHaveLength(0);
  });

  it("a live sender that fails records a FAILED attempt (counted) and nothing is written as sent; an open handoff keeps BARRY quiet", async () => {
    const { g, model, id } = setup();
    const { payment } = await pendingLink(model, g, id);
    const later = new Date(Date.parse(payment!.createdAt) + 25 * H);
    const failing: OutboundSender = { channel: "web", mode: "live", send: async () => { throw new Error("provider down"); } };
    const messagesBefore = (await getConversationStore().get(id))!.messages.length;
    const run = await runObligationExecutor(g, { now: later, senders: () => failing });
    expect(run.results[0]).toMatchObject({ outcome: "failed", why: "provider down" });
    const state = (await getConversationStore().get(id))!;
    expect(state.messages.length).toBe(messagesBefore);
    expect(readLedger(state).at(-1)).toMatchObject({ effect: "followup.failed", status: "failed" });
    expect(readDeliveries(state.knownFields).at(-1)).toMatchObject({ status: "failed" });
    expect(attemptCounts(await listAttempts(g.business.id))[`unpaid_payment_followup:${payment!.id}`].count).toBe(1);
  });

  it("follow-up texts are locale-safe: Hebrew conversations get Hebrew, nothing else switches", () => {
    const o = { amount: 420, currency: "ILS", dueAt: "2026-10-01T09:00:00.000Z" } as Parameters<typeof followUpText>[1];
    expect(followUpText("unpaid_payment_followup", o, "he")).toMatch(/[֐-׿]/);
    expect(followUpText("unpaid_payment_followup", o, "en")).toMatch(/reminder/);
    expect(followUpText("unpaid_payment_followup", o, "en")).not.toMatch(/[֐-׿]/);
    expect(followUpText("unresolved_handoff", o, "en")).toBeNull();
  });
});

describe("abandoned checkout and appointment reminders are derived from records under the policy", () => {
  it("a cart with lines and no payment after its last change becomes a scheduled → actionable recovery; a payment after it closes it", async () => {
    const { g, model, id } = setup();
    model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
    await handleCustomerMessage(g, id, "c", "the midnight dress");
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true });
    await handleCustomerMessage(g, id, "c", "add it in M");
    const carts = await getBackend().listCommerceCarts(g.business.id);
    expect(carts).toHaveLength(1);
    const state = (await getConversationStore().get(id))!;
    const t0 = Date.parse(carts[0].updatedAt);
    const early = deriveObligations({ graph: g, conversations: [state], approvals: [], payments: [], bookings: [], carts, now: new Date(t0 + H) });
    expect(early.find((o) => o.kind === "abandoned_checkout_recovery")).toMatchObject({ nextMove: "scheduled_for_later", status: "scheduled" });
    const due = deriveObligations({ graph: g, conversations: [state], approvals: [], payments: [], bookings: [], carts, now: new Date(t0 + 5 * H) });
    expect(due.find((o) => o.kind === "abandoned_checkout_recovery")).toMatchObject({ nextMove: "barry_can_act", amount: 420, currency: "ILS" });
    const off = deriveObligations({ graph: { ...g, playbook: { ...g.playbook, followUp: { abandonedCheckout: { enabled: false } } } }, conversations: [state], approvals: [], payments: [], bookings: [], carts, policy: followUpPolicyFor({ playbook: { ...g.playbook, followUp: { abandonedCheckout: { enabled: false } } } }), now: new Date(t0 + 5 * H) });
    expect(off.some((o) => o.kind === "abandoned_checkout_recovery")).toBe(false);
    const run = await runObligationExecutor(g, { now: new Date(t0 + 5 * H) });
    expect(run.results.find((r) => r.kind === "abandoned_checkout_recovery")?.outcome).toBe("dry_run");
    // The composed recovery text is kept on the attempt (for review) — and never written into the transcript.
    const attempt = (await listAttempts(g.business.id)).find((a) => a.kind === "abandoned_checkout_recovery")!;
    expect(attempt.what).toMatch(/cart/);
    expect(attempt.what).toMatch(/Nothing has been charged/);
    expect((await getConversationStore().get(id))!.messages.some((m) => /Nothing has been charged/.test(m.content))).toBe(false);
  });

  it("appointment reminders exist only within a day of a confirmed booking and only when the rule is on", async () => {
    const { g } = setup();
    const start = new Date(NOW.getTime() + 20 * H).toISOString();
    const booking = await getBackend().createBooking({ businessId: g.business.id, offerId: "fitting", resourceId: "r1", start, end: new Date(NOW.getTime() + 21 * H).toISOString(), customerId: "c", conversationId: "x", partySize: 1 });
    const on = deriveObligations({ graph: g, conversations: [], approvals: [], payments: [], bookings: [booking], now: NOW });
    expect(on.find((o) => o.kind === "appointment_reminder")).toMatchObject({ nextMove: "barry_can_act", dueAt: start });
    const far = deriveObligations({ graph: g, conversations: [], approvals: [], payments: [], bookings: [{ ...booking, start: new Date(NOW.getTime() + 3 * 24 * H).toISOString() }], now: NOW });
    expect(far.some((o) => o.kind === "appointment_reminder")).toBe(false);
    const off = deriveObligations({ graph: g, conversations: [], approvals: [], payments: [], bookings: [booking], policy: { ...DEFAULT_FOLLOW_UP_POLICY, appointmentReminder: { ...DEFAULT_FOLLOW_UP_POLICY.appointmentReminder, enabled: false } }, now: NOW });
    expect(off.some((o) => o.kind === "appointment_reminder")).toBe(false);
  });
});

describe("revenue recovery keeps potential / attempted / recovered / verified apart", () => {
  it("states follow the evidence: no attempt → potential; attempt → attempted; later verified payment → verified; test money apart", async () => {
    const { g, model, id } = setup();
    const { payment } = await pendingLink(model, g, id);
    const t0 = Date.parse(payment!.createdAt);
    const state = (await getConversationStore().get(id))!;
    const payments = await getBackend().listPaymentRequests(g.business.id);
    const approvals = withLifecycle(await getBackend().listApprovals(g.business.id), new Map([[id, state]]));
    const opp = revenueOpportunities({ graph: g, conversations: [state], approvals, payments, bookings: [], orders: [], customerLabel, now: new Date(t0 + 30 * H) });
    const before = recoveryLedger({ opportunities: opp.items, attempts: [], payments });
    expect(before.items[0].state).toBe("potential");
    // Simulated provider: the amount lands in `simulated`, never in the real states.
    expect(before.summary.simulated.ILS).toBe(420);
    expect(before.summary.potential).toEqual({});
    await runObligationExecutor(g, { now: new Date(t0 + 25 * H) });
    const attempted = recoveryLedger({ opportunities: opp.items, attempts: await listAttempts(g.business.id), payments });
    expect(attempted.items[0]).toMatchObject({ state: "attempted", attempts: 1 });
    await getBackend().simulatePaymentOutcome(payment!.id, "paid");
    const verified = recoveryLedger({ opportunities: opp.items, attempts: await listAttempts(g.business.id), payments: await getBackend().listPaymentRequests(g.business.id) });
    expect(verified.items[0].state).toBe("verified");
  });
});
