import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { getConversationStore, type ConversationState } from "@/lib/state";
import { setReasonerForTests } from "@/lib/reasoner";
import { readLedger, appendLedger } from "@/lib/runtime/ledger";
import { processInbound, readDeliveries, type OutboundSender } from "@/lib/channels/gateway";
import { applyControlChange, resetControlsCacheForTests } from "@/lib/hq/controls";
import { runObligationExecutor } from "@/lib/operator/executor";
import { attemptCounts, listAttempts, type ExecutionAttempt } from "@/lib/operator/attempts";
import { deriveObligations } from "@/lib/operator/obligations";
import type { Obligation } from "@/lib/operator/obligation-model";
import { lastSaid, reachedCustomer, executionStateOf, truthfulLedger, truthfulTranscript } from "@/lib/operator/execution-state";
import { activityFeed, nowWorking, workflows } from "@/lib/owner/control-room";
import { operationProgress } from "@/lib/owner/operation-model";
import { conversationStory } from "@/lib/owner/story";
import { getOwnerConversation } from "@/lib/owner/conversation";
import { isVerifiedPaid, revenueSummary } from "@/lib/owner/revenue";
import { businessActivity } from "@/lib/hq/activity";
import { workProgress } from "@/components/next/model";
import type { OwnerWorkspace } from "@/lib/owner/service";
import { setBusinessGraphResolverForTests } from "@/lib/business-graph-repository";
import { getBusinessGraph } from "@/lib/fixtures";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * PAID-PILOT P0 PHASE 2 — TRUTHFUL EXECUTION. BARRY may only say sent / reached / contacted when a message
 * really left, and paid / recovered when the provider verified it. Dry runs and failures are recorded as
 * exactly that — never in the transcript as if said, never as contact. Legacy records written before this
 * model read truthfully without being rewritten.
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

function setup() {
  const r = isolatedRetailer();
  dispose = r.dispose;
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  return { ...r, model, id: conv("truth") };
}

async function pendingLink(model: ScriptedModel, g: ReturnType<typeof setup>["g"], id: string) {
  model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
  await handleCustomerMessage(g, id, "c", "the midnight dress");
  model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true });
  await handleCustomerMessage(g, id, "c", "add it in M");
  model.plan = () => ({ commerce: { intent: "checkout" }, customerInfo: { name: "Dana", phone: "0501234567" }, evidence: { "customerInfo.name": "Dana", "customerInfo.phone": "0501234567" }, advancesTransaction: true });
  await handleCustomerMessage(g, id, "c", "checkout please, Dana 0501234567");
  return (await getBackend().listPaymentRequests(g.business.id)).find((p) => p.conversationId === id)!;
}

const live = (): OutboundSender & { sent: string[] } => {
  const sent: string[] = [];
  return { channel: "web", mode: "live", sent, send: async (_to, text) => (sent.push(text), { providerMessageId: `pm_${sent.length}` }) };
};
const refusing: OutboundSender = { channel: "web", mode: "live", send: async () => Promise.reject(new Error("WhatsApp send failed (400 / 131047)")) };

async function obligationsAfter(g: ReturnType<typeof setup>["g"], at: Date): Promise<Obligation[]> {
  const conversations = await getConversationStore().listByBusiness(g.business.id);
  return deriveObligations({ graph: g, conversations, approvals: [], payments: await getBackend().listPaymentRequests(g.business.id), bookings: [], attempts: attemptCounts(await listAttempts(g.business.id)), now: at }).map((d) => ({ ...d, businessId: g.business.id, createdAt: at.toISOString(), updatedAt: at.toISOString() }) as Obligation);
}

describe("the execution-state vocabulary", () => {
  it("only sent / delivered mean the customer received something", () => {
    expect(reachedCustomer(executionStateOf("sent"))).toBe(true);
    expect(reachedCustomer(executionStateOf("delivered"))).toBe(true);
    for (const s of ["dry_run", "failed", "skipped", "cancelled", undefined]) expect(reachedCustomer(executionStateOf(s))).toBe(false);
  });
});

describe("dry-run follow-up: recorded as a test, never as contact", () => {
  it("nothing in the transcript, a dry-run ledger entry, zero reached, and every surface says test mode", async () => {
    const { g, model, id } = setup();
    const payment = await pendingLink(model, g, id);
    const before = (await getConversationStore().get(id))!.messages.length;
    const later = new Date(Date.parse(payment.createdAt) + 25 * H);
    const run = await runObligationExecutor(g, { now: later });
    expect(run.results[0]).toMatchObject({ outcome: "dry_run" });

    const state = (await getConversationStore().get(id))!;
    expect(state.messages).toHaveLength(before);
    expect(readLedger(state).at(-1)).toMatchObject({ effect: "followup.dry_run", status: "no_effect" });
    expect(readDeliveries(state.knownFields).at(-1)).toMatchObject({ status: "dry_run" });
    const story = conversationStory(state);
    expect(story.tried.join("\n")).toMatch(/Test mode: .*NOT sent/);
    expect(story.tried.join("\n")).not.toMatch(/^Sent follow-up/m);

    const obligations = await obligationsAfter(g, later);
    const o = obligations.find((x) => x.kind === "unpaid_payment_followup")!;
    expect(o).toMatchObject({ attempts: 1, sentAttempts: 0 });
    expect(o.reason).toMatch(/Test mode/);
    expect(o.nextAction).toMatch(/not sent/);
    const [flow] = workflows({ obligations });
    expect(flow).toMatchObject({ contacted: 0, practiced: 1, waiting: 0 });
    expect(nowWorking({ obligations, interventions: [] }).some((l) => /Waiting on/.test(l.text))).toBe(false);
    expect(activityFeed({ obligations, outcomes: [], approvals: [], conversations: [] }).map((a) => a.text).join("\n")).toMatch(/Test mode: follow-up recorded, not sent/);
  });
});

describe("real send: only now is it sent / reached", () => {
  it("transcript, ledger, delivery (tied to its message) and every count agree", async () => {
    const { g, model, id } = setup();
    const payment = await pendingLink(model, g, id);
    // Real sends happen only in LIVE mode (a simulator business only dry-runs).
    await applyControlChange(g.business.id, { mode: "live" }, { by: "founder", reason: "go live" });
    const sender = live();
    const later = new Date(Date.parse(payment.createdAt) + 25 * H);
    const run = await runObligationExecutor(g, { now: later, senders: () => sender });
    expect(run.results[0]).toMatchObject({ outcome: "sent" });
    expect(sender.sent).toHaveLength(1);

    const state = (await getConversationStore().get(id))!;
    expect(state.messages.at(-1)).toMatchObject({ role: "barry", content: sender.sent[0] });
    expect(readLedger(state).at(-1)).toMatchObject({ effect: "followup.sent", status: "effected" });
    const d = readDeliveries(state.knownFields).at(-1)!;
    expect(d).toMatchObject({ status: "sent", providerMessageId: "pm_1", messageAt: state.messages.at(-1)!.at });
    expect(truthfulTranscript(state).at(-1)!.notSent).toBeUndefined();
    expect(conversationStory(state).tried.join("\n")).toMatch(/Sent follow-up/);

    const obligations = await obligationsAfter(g, later);
    expect(obligations.find((x) => x.kind === "unpaid_payment_followup")).toMatchObject({ attempts: 1, sentAttempts: 1 });
    expect(workflows({ obligations })[0]).toMatchObject({ contacted: 1, practiced: 0, waiting: 1 });
  });
});

describe("failed send: the customer got nothing, and it says so", () => {
  it("no transcript message, a failed ledger entry, a failed delivery, zero reached", async () => {
    const { g, model, id } = setup();
    const payment = await pendingLink(model, g, id);
    const before = (await getConversationStore().get(id))!.messages.length;
    const later = new Date(Date.parse(payment.createdAt) + 25 * H);
    // Real sends happen only in LIVE mode (a simulator business only dry-runs).
    await applyControlChange(g.business.id, { mode: "live" }, { by: "founder", reason: "go live" });
    const run = await runObligationExecutor(g, { now: later, senders: () => refusing });
    expect(run.results[0]).toMatchObject({ outcome: "failed" });
    const state = (await getConversationStore().get(id))!;
    expect(state.messages).toHaveLength(before);
    expect(readLedger(state).at(-1)).toMatchObject({ effect: "followup.failed", status: "failed" });
    expect(readDeliveries(state.knownFields).at(-1)).toMatchObject({ status: "failed" });
    expect(conversationStory(state).tried.join("\n")).toMatch(/refused it; the customer got nothing/);
    const obligations = await obligationsAfter(g, later);
    expect(workflows({ obligations })[0]).toMatchObject({ contacted: 0 });
  });
});

describe("THE AUDIT CASE: '6 of 7 reached' when nothing was ever sent", () => {
  // Exactly what Rina's records held: 7 abandoned checkouts, 6 dry-run attempts, 0 sends.
  const cart = (i: number, extra: Partial<Obligation> = {}) =>
    ({ key: `abandoned_checkout_recovery:cart_${i}`, businessId: "b", kind: "abandoned_checkout_recovery", source: "s", evidence: [], conversationId: `c${i}`, customer: `Customer ${i}`, subject: "cart", reason: "r", desiredOutcome: "d", nextAction: "n", nextMove: "waiting_on_customer", owner: "customer", eligibleAt: "2026-10-01T00:00:00.000Z", status: "waiting_on_customer", authority: "none", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", amount: 390, currency: "ILS", ...extra }) as Obligation;

  it("current records (sentAttempts recorded): 0 of 7 reached, 6 test runs, no 'waiting on customers'", () => {
    const obligations = [...Array.from({ length: 6 }, (_, i) => cart(i, { attempts: 1, sentAttempts: 0, lastAttemptAt: "2026-10-01T18:48:51.389Z" })), cart(6, { nextMove: "scheduled_for_later", status: "scheduled" })];
    const ws = { obligations, ownerOperations: [], operator: undefined } as unknown as OwnerWorkspace;
    const [flow] = workflows(ws);
    expect(flow).toMatchObject({ eligible: 7, contacted: 0, practiced: 6, waiting: 0 });
    const p = workProgress(ws, { id: "rule:abandoned_checkout_recovery", kind: "followup", workflow: "abandoned_checkout_recovery", state: "working", customers: 7 }, "en", (en) => en);
    expect(p.reached).toBe(0);
    expect(p.line).toBe("7 found · test mode: 6 recorded, nothing sent");
    expect(p.line).not.toMatch(/reached/);
    const he = workProgress(ws, { id: "rule:abandoned_checkout_recovery", kind: "followup", workflow: "abandoned_checkout_recovery", state: "working", customers: 7 }, "he", (_en, he) => he);
    expect(he.line).toMatch(/מצב בדיקה/);
  });

  it("LEGACY obligation records (attempts only, no sentAttempts) prove no contact: still 0 reached", () => {
    const obligations = Array.from({ length: 6 }, (_, i) => cart(i, { attempts: 1, lastAttemptAt: "2026-10-01T18:48:51.389Z" }));
    expect(workflows({ obligations })[0]).toMatchObject({ contacted: 0, practiced: 6, waiting: 0 });
  });

  it("attempt records split the budget from the truth: 6 dry runs = 6 attempts, 0 sent", () => {
    const attempts = Array.from({ length: 6 }, (_, i) => ({ id: `abandoned_checkout_recovery:cart_${i}#1`, businessId: "b", obligationKey: `abandoned_checkout_recovery:cart_${i}`, kind: "abandoned_checkout_recovery", n: 1, at: "2026-10-01T18:48:51.389Z", status: "dry_run", what: "Would send: …", evidence: [], idempotencyKey: "x" }) satisfies ExecutionAttempt);
    const counts = attemptCounts(attempts);
    expect(Object.values(counts).every((c) => c.count === 1 && c.sent === 0 && c.dryRun === 1)).toBe(true);
  });

  it("an owner operation of dry runs reports 0 contacted, not 'waiting on customers'", () => {
    const targets = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, conversationId: `c${i}`, customer: `C${i}`, eligibility: "eligible" as const, result: { outcome: "dry_run" as const, why: "attempt 1 of 1", at: "2026-10-01T18:48:51.389Z" } }));
    const p = operationProgress({ targets }, [], {});
    expect(p).toMatchObject({ contacted: 0, dryRun: 6, waiting: 0 });
  });
});

describe("legacy conversation records written before this model", () => {
  /** What the old executor wrote for a dry run: the text IN the transcript, `followup.sent` in the ledger, a dry_run delivery. */
  async function legacyDryRun(g: ReturnType<typeof setup>["g"], id: string): Promise<ConversationState> {
    const store = getConversationStore();
    const state = await store.getOrCreate(id, g.business.id, "c");
    state.messages.push({ role: "customer", content: "I'll think about it", at: "2026-10-01T10:00:00.000Z" });
    const at = "2026-10-01T18:48:51.389Z";
    const attemptId = `abandoned_checkout_recovery:cart_legacy#1`;
    state.messages.push({ role: "barry", content: "Hi — I noticed you left items in your cart (₪390). Would you like to complete the order? Nothing has been charged.", at });
    appendLedger(state, { operation: "followUp", effect: "followup.sent", status: "effected", describes: "follow-up (abandoned checkout recovery)", terms: { attempt: 1 }, reference: attemptId });
    state.knownFields.__channelDelivery = JSON.stringify([{ at, channel: "web", inboundId: attemptId, status: "dry_run" }]);
    await store.save(state);
    return (await store.get(id))!;
  }

  it("stay readable, and read truthfully: the dry-run message is marked not sent, the entry reads as a dry run", async () => {
    const { g, id } = setup();
    const state = await legacyDryRun(g, id);
    // Stored history is untouched (append-only)…
    expect(readLedger(state).at(-1)).toMatchObject({ effect: "followup.sent" });
    expect(state.messages.at(-1)!.role).toBe("barry");
    // …and every owner-facing read says what really happened.
    expect(truthfulLedger(state).at(-1)).toMatchObject({ effect: "followup.dry_run", status: "no_effect" });
    expect(truthfulTranscript(state).at(-1)).toMatchObject({ role: "barry", notSent: "dry_run" });
    expect(lastSaid(state)).toMatchObject({ role: "customer" });
    // Read back from Postgres the same instant is spelled "+00:00" — still the same message.
    const pg = { ...state, messages: state.messages.map((m) => ({ ...m, at: m.at.replace(/Z$/, "+00:00") })) };
    expect(truthfulTranscript(pg).at(-1)).toMatchObject({ role: "barry", notSent: "dry_run" });
    expect(lastSaid(pg)).toMatchObject({ role: "customer" });
    expect(conversationStory(state).tried.join("\n")).toMatch(/Test mode: .*NOT sent/);
    expect(conversationStory(state).standing.join("\n")).not.toMatch(/follow-up/);
    const view = (await getOwnerConversation(g, id))!;
    expect(view.messages.at(-1)).toMatchObject({ from: "barry", notSent: "dry_run" });
    const activity = businessActivity({ graph: g, conversations: [state], approvals: [], payments: [], bookings: [], orders: [] } as never);
    const line = activity.find((a) => a.conversationId === id && /follow-up/.test(a.what));
    expect(line?.what).toMatch(/test mode: recorded, NOT sent/);
  });
});

describe("channel replies in test mode (WhatsApp dry run)", () => {
  it("the reply's delivery names its message, so the owner sees it as not sent", async () => {
    const { g } = setup();
    setBusinessGraphResolverForTests((bid) => (bid === g.business.id ? g : getBusinessGraph(bid)));
    const prev = dispose;
    dispose = () => {
      setBusinessGraphResolverForTests(undefined);
      prev?.();
    };
    const id = `wa:${g.business.id}:972500000077`;
    const dry: OutboundSender = { channel: "whatsapp", mode: "dry_run", send: async () => ({}) };
    const out = await processInbound({ businessId: g.business.id, conversationId: id, customerId: "wa:972500000077", identity: { channel: "whatsapp", channelUserId: "972500000077", verifiedIdentifier: "phone:972500000077" }, text: "hello", receivedAt: new Date().toISOString(), inboundId: "wamid.test.1" }, dry);
    expect(out.status).toBe("processed");
    const state = (await getConversationStore().get(id))!;
    const reply = [...state.messages].reverse().find((m) => m.role === "barry")!;
    expect(readDeliveries(state.knownFields).at(-1)).toMatchObject({ status: "dry_run", messageAt: reply.at });
    expect(truthfulTranscript(state).find((m) => m.at === reply.at && m.role === "barry")).toMatchObject({ notSent: "dry_run" });
  });
});

describe("money: only provider-verified outcomes", () => {
  it("a provider-confirmed payment counts; a simulated one is test money; a pending real link is never revenue", async () => {
    const { g } = setup();
    const backend = getBackend();
    const mk = (provider: string, conversationId: string) => backend.createPaymentRequest({ businessId: g.business.id, conversationId, customerId: "c", amount: 390, currency: "ILS", reason: "order", provider, providerPaymentId: `pp_${conversationId}` });
    const real = await mk("payplus", "c-real");
    const confirmed = await backend.updatePaymentRequestStatus(real.id, "paid", { verifiedAt: new Date().toISOString(), providerEventId: "evt_1" });
    const sim = await mk("memory", "c-sim");
    const simPaid = await backend.simulatePaymentOutcome(sim.id, "paid");
    const pending = await mk("payplus", "c-pending");
    expect(isVerifiedPaid(confirmed)).toBe(true);
    expect(isVerifiedPaid(pending)).toBe(false);
    const summary = revenueSummary({ graph: g, conversations: [], payments: [confirmed, simPaid, pending], bookings: [], orders: [], approvals: [] });
    expect(summary.direct).toEqual({ ILS: 390 });
    expect(summary.simulatedPaid).toEqual({ ILS: 390 });
  });

  it("'recovered' needs a follow-up that really reached the customer — a test run never recovers money", () => {
    const paidAfter = { status: "completed" as const, completion: { at: "2026-10-01T10:00:00.000Z", evidence: "payment request pay_1 verified paid" } };
    const base = { key: "k", businessId: "b", kind: "unpaid_payment_followup", source: "s", evidence: [], conversationId: "c1", customer: "Dana", subject: "s", reason: "r", desiredOutcome: "d", nextAction: "n", nextMove: "waiting_on_customer", owner: "customer", eligibleAt: "2026-10-01T00:00:00.000Z", authority: "none", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", amount: 420, currency: "ILS" } as unknown as Obligation;
    expect(workflows({ obligations: [{ ...base, ...paidAfter, attempts: 1, sentAttempts: 0 }] })[0].recovered).toEqual({});
    expect(workflows({ obligations: [{ ...base, ...paidAfter, attempts: 1, sentAttempts: 1 }] })[0].recovered).toEqual({ ILS: 420 });
  });
});
