import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { decide } from "@/lib/policy";
import { getBackend } from "@/lib/store";
import { getConversationStore, createInitialConversationState, type ConversationState } from "@/lib/state";
import { setReasonerForTests } from "@/lib/reasoner";
import { getBusinessGraph } from "@/lib/fixtures";
import { buildLogisticsDemoGraph, resetDemoHelpdeskForTests } from "@/lib/fixtures/logistics-demo";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { appendLedger } from "@/lib/runtime/ledger";
import { CHANNEL_DELIVERY_KEY, processInbound } from "@/lib/channels/gateway";
import { applyControlChange, applyFounderControls, DEFAULT_CONTROLS, loadControls, listControlAudit, resetControlsCacheForTests } from "@/lib/hq/controls";
import { deriveIncidents, incidentSeverity, setIncidentState, loadIncidentStates } from "@/lib/hq/incidents";
import { getBusinessStatus, summarizeFleet, type BusinessStatus } from "@/lib/hq/fleet";
import { askHq } from "@/lib/hq/ask";
import { releaseState, recordWorkVerdict, currentRelease } from "@/lib/release/manifest";
import { ACCEPTANCE_MANIFEST } from "@/lib/release/current";
import { launchChecklist } from "@/lib/hq/launch";
import { deriveObligations, reconcileObligations, isOpen } from "@/lib/operator/obligations";
import type { AiHealth } from "@/lib/owner/service";
import type { ApprovalRecord, PaymentRequestRecord } from "@/lib/store/types";
import { ScriptedModel, approvalsOf, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * CHECKPOINT 1 + 3 + 4 — founder control plane (controls tighten authority; incidents; fleet), the
 * proactive operator (obligations lifecycle) and the design-partner gate. Deterministic (memory store,
 * scripted model, injected clocks). Not live proof.
 */

let dispose: (() => void) | undefined;
beforeEach(() => resetControlsCacheForTests());
afterEach(() => {
  setReasonerForTests(undefined);
  resetDemoHelpdeskForTests();
  resetControlsCacheForTests();
  dispose?.();
  dispose = undefined;
});

const NOW = new Date("2026-09-30T12:00:00.000Z");
const hoursAgo = (h: number, from = NOW) => new Date(from.getTime() - h * 3600_000).toISOString();

function setup() {
  const r = isolatedRetailer();
  dispose = r.dispose;
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  return { ...r, model, id: conv("hq") };
}

async function midnightInCart(model: ScriptedModel, g: ReturnType<typeof setup>["g"], id: string) {
  model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
  await handleCustomerMessage(g, id, "c", "the midnight dress");
  model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true });
  return handleCustomerMessage(g, id, "c", "add it in M");
}

// ── Founder controls: only ever tighten ────────────────────────────────────────────────────────────

describe("founder controls tighten authority, never loosen it", () => {
  it("pure: allowed → denied under a write pause; allowed → requires_approval under human-only; a paused capability is denied; reads are untouched; denied stays denied", () => {
    const base = { status: "allowed" as const };
    const paused = { ...DEFAULT_CONTROLS, pauseConsequentialWrites: true };
    expect(applyFounderControls(paused, "createCommerceCheckout", { cartId: "x", amount: 100 }, base)).toMatchObject({ status: "denied", policyId: "founder_control:writes_paused" });
    expect(applyFounderControls(paused, "searchProducts", {}, base)).toEqual({ status: "allowed" });
    expect(applyFounderControls(paused, "verifyPayment", {}, base)).toEqual({ status: "allowed" });
    expect(applyFounderControls(paused, "invokeCapability", { capability: "shipping.track", input: {} }, base)).toEqual({ status: "allowed" });
    expect(applyFounderControls(paused, "invokeCapability", { capability: "support.ticket.create", input: {} }, base)).toMatchObject({ status: "denied" });
    const human = { ...DEFAULT_CONTROLS, approvalRequiredForAll: true };
    expect(applyFounderControls(human, "createCommerceCheckout", {}, base)).toMatchObject({ status: "requires_approval", policyId: "founder_control:supervised" });
    expect(applyFounderControls(human, "createCommerceCheckout", {}, { status: "requires_approval" })).toEqual({ status: "allowed" }); // already requires approval: unchanged
    expect(applyFounderControls(human, "searchProducts", {}, base)).toEqual({ status: "allowed" });
    const capPaused = { ...DEFAULT_CONTROLS, pausedCapabilities: ["commerce.checkout.create", "support.*"] };
    expect(applyFounderControls(capPaused, "createCommerceCheckout", {}, base)).toMatchObject({ status: "denied", policyId: "founder_control:paused_capability" });
    expect(applyFounderControls(capPaused, "addToCart", {}, base)).toEqual({ status: "allowed" });
    expect(applyFounderControls(capPaused, "invokeCapability", { capability: "support.ticket.create", input: {} }, base)).toMatchObject({ status: "denied" });
    expect(applyFounderControls(capPaused, "invokeCapability", { capability: "shipping.track", input: {} }, base)).toEqual({ status: "allowed" });
    expect(applyFounderControls(paused, "createCommerceCheckout", {}, { status: "denied" })).toEqual({ status: "allowed" }); // the base denial stands; nothing to add
  });

  it("policy engine: the business's own decision is tightened by the loaded controls; a change needs a reason and is audited before → after; reverting restores it", async () => {
    const { g, model, id } = setup();
    await midnightInCart(model, g, id);
    const checkout = { action: "createCommerceCheckout", params: { cartId: "c", amount: 420 } };
    expect(decide(g, checkout).status).toBe("allowed");
    await expect(applyControlChange(g.business.id, { pauseConsequentialWrites: true }, { by: "founder", reason: " " })).rejects.toThrow(/reason/);
    const { audit } = await applyControlChange(g.business.id, { pauseConsequentialWrites: true }, { by: "founder", reason: "provider incident", now: NOW });
    expect(audit).toMatchObject({ by: "founder", reason: "provider incident", before: { pauseConsequentialWrites: false }, after: { pauseConsequentialWrites: true } });
    expect(decide(g, checkout)).toMatchObject({ status: "denied", policyId: "founder_control:writes_paused" });
    expect(decide(g, { action: "searchProducts", params: {} }).status).toBe("allowed");
    // Runtime: a cart change is refused at authority — no cart effect, the turn stops on policy_denied.
    model.plan = () => ({ commerce: { intent: "change_quantity", subject: "Midnight", quantity: 2 }, advancesTransaction: true });
    const refused = await handleCustomerMessage(g, id, "c", "make it two");
    expect(refused.turn.trace?.stop).toEqual({ reason: "policy_denied", outcome: "updateCartLine" });
    expect(refused.turn.trace?.steps[0].policy).toMatchObject({ status: "denied", policyId: "founder_control:writes_paused" });
    // Reversible: resume → the same change goes through.
    await applyControlChange(g.business.id, { pauseConsequentialWrites: false }, { by: "founder", reason: "provider healthy again" });
    const ok = await handleCustomerMessage(g, id, "c", "make it two");
    expect(ok.turn.trace?.steps.map((s) => [s.action, s.policy.status, s.result?.ok])).toEqual([["updateCartLine", "allowed", true]]);
    const log = await listControlAudit(g.business.id);
    expect(log.map((a) => a.after.pauseConsequentialWrites)).toEqual([false, true]);
    expect((await loadControls(g.business.id)).pauseConsequentialWrites).toBe(false);
  });

  it("human-only mode routes an otherwise-allowed checkout to the owner; the founder's controls never loosen a business denial", async () => {
    const { g, model, id } = setup();
    await midnightInCart(model, g, id);
    await applyControlChange(g.business.id, { approvalRequiredForAll: true, mode: "supervised" }, { by: "founder", reason: "design partner supervision" });
    model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, customerInfo: { name: "Adi", phone: "0505550114" }, evidence: { "customerInfo.name": "Adi", "customerInfo.phone": "0505550114" } });
    const out = await handleCustomerMessage(g, id, "c", "checkout, Adi 0505550114");
    expect(out.turn.trace?.steps[0]).toMatchObject({ action: "createCommerceCheckout", policy: { status: "requires_approval", policyId: "founder_control:supervised" } });
    expect(out.state.knownFields.__paymentRequestId).toBeUndefined();
    expect((await approvalsOf(g, id)).map((a) => [a.requestedAction, a.status, a.policyId])).toEqual([["createCommerceCheckout", "pending", "founder_control:supervised"]]);
    expect(decide(g, { action: "refund", params: { amount: 10 } }).status).toBe("denied"); // not enabled for Rina: stays denied
  });

  it("a disabled channel is not answered on: nothing is processed, nothing sent; re-enabling restores it", async () => {
    const g = getBusinessGraph("spa");
    setReasonerForTests(new ScriptedModel(() => ({ advancesTransaction: false })));
    await applyControlChange(g.business.id, { disabledChannels: ["whatsapp"] }, { by: "founder", reason: "number compromised" });
    let sent = 0;
    const sender = { channel: "whatsapp" as const, mode: "dry_run" as const, send: async () => (sent++, {}) };
    const msg = { businessId: g.business.id, conversationId: `wa:${conv("chan")}`, identity: { channel: "whatsapp" as const, channelUserId: "972500000001" }, text: "hello", receivedAt: new Date().toISOString(), inboundId: `m-${Date.now()}` };
    const blocked = await processInbound(msg, sender);
    expect(blocked).toMatchObject({ status: "failed", error: /disabled by the founder/ });
    expect(await getConversationStore().get(msg.conversationId)).toBeUndefined();
    await applyControlChange(g.business.id, { disabledChannels: [] }, { by: "founder", reason: "restored" });
    const ok = await processInbound({ ...msg, inboundId: `m2-${Date.now()}` }, sender);
    expect(ok.status).toBe("processed");
    expect(sent).toBe(0); // dry run
  });
});

// ── Incidents ──────────────────────────────────────────────────────────────────────────────────────

const ai = (over: Partial<AiHealth> = {}): AiHealth => ({ status: "healthy", summary: "fine", mode: "simulated", model: null, turnsSampled: 0, understandingFailures: 0, composerFailures: 0, ...over });

function approval(over: Partial<ApprovalRecord> & { id: string; createdAt: string }): ApprovalRecord {
  return { businessId: "fashion-retailer", conversationId: "c1", customerId: "x", requestedAction: "createCommerceCheckout", requestedInput: { amount: 500, currency: "ILS" }, reason: "over limit", policyId: "max_auto_payment_amount", status: "pending", ...over };
}

describe("incidents: deterministic severity, dedupe, founder state", () => {
  it("severity rules are age-aware only where stated; AI unavailable, undelivered replies and unhealthy connections are always high", () => {
    expect(incidentSeverity("ai_unavailable", 0)).toBe("high");
    expect(incidentSeverity("undelivered_reply", 0)).toBe("high");
    expect(incidentSeverity("connection_unhealthy", 0)).toBe("high");
    expect(incidentSeverity("held_approval_stuck", 3 * 3600_000)).toBe("medium");
    expect(incidentSeverity("held_approval_stuck", 30 * 3600_000)).toBe("high");
    expect(incidentSeverity("failed_write", 0)).toBe("medium");
    expect(incidentSeverity("stale_unpaid_link", 0)).toBe("low");
  });

  it("derives from records: AI down, a held request older than 2h, a failed write, an undelivered reply, a broken connection — deduped by subject with first/last seen", () => {
    const g = getBusinessGraph("fashion-retailer");
    const c = createInitialConversationState("c1", g.business.id, "x");
    c.knownFields.__intentHold = "1";
    appendLedger(c, { operation: "createCommerceCheckout", describes: "checkout payment link", terms: {}, effect: "createCommerceCheckout.failed", status: "failed" });
    appendLedger(c, { operation: "createCommerceCheckout", describes: "checkout payment link", terms: {}, effect: "createCommerceCheckout.failed", status: "failed" });
    c.knownFields[CHANNEL_DELIVERY_KEY] = JSON.stringify([{ at: hoursAgo(1), channel: "whatsapp", inboundId: "m1", status: "failed", error: "401" }]);
    const held = withLifecycle([approval({ id: "ap_held", createdAt: hoursAgo(5) })], new Map([["c1", c]]));
    // A held lifecycle needs an unverified later message; simulate via the lifecycle input by marking hold directly.
    const heldApprovals = held.map((a) => ({ ...a, lifecycle: "held" as const, hold: { reason: "understanding_unverified" as const } }));
    const incidents = deriveIncidents({
      graph: g,
      conversations: [c],
      approvals: heldApprovals,
      payments: [],
      connections: [{ capability: "payments", provider: "payplus", status: "error", origin: "business_connection", simulated: false, lastVerifiedAt: null, permissions: [], settings: {}, setup: [], missing: ["PAYPLUS_API_KEY"], operations: [] }],
      ai: ai({ status: "unavailable", summary: "quota exhausted", understandingFailures: 3, lastFailure: { at: hoursAgo(1), kind: "provider_quota_exhausted" } }),
      now: NOW,
    });
    const byKind = Object.fromEntries(incidents.map((i) => [i.kind, i]));
    expect(byKind.ai_unavailable).toMatchObject({ severity: "high", status: "current", occurrences: 3, nextAction: expect.stringMatching(/credit/i) });
    expect(byKind.held_approval_stuck).toMatchObject({ severity: "medium", links: { interventionId: "held_approval:ap_held", conversationId: "c1" } });
    expect(byKind.failed_write).toMatchObject({ severity: "medium", occurrences: 2, capability: "createCommerceCheckout" });
    expect(byKind.undelivered_reply).toMatchObject({ severity: "high", capability: "channel.whatsapp" });
    expect(byKind.connection_unhealthy).toMatchObject({ severity: "high", capability: "payments", links: { provider: "payplus" } });
    expect(incidents.filter((i) => i.kind === "failed_write")).toHaveLength(1); // deduped
    expect(incidents[0].severity).toBe("high"); // sorted by severity
    for (const i of incidents) expect(i.evidence.length).toBeGreaterThan(0);
  });

  it("acknowledge keeps it open as acknowledged; resolve closes it; a recurrence AFTER the resolution reopens it", async () => {
    const g = getBusinessGraph("fashion-retailer");
    const business = `${g.business.id}-inc-${Date.now()}`;
    const graph = { ...g, business: { ...g.business, id: business } };
    const derive = (failAt: string, states: Awaited<ReturnType<typeof loadIncidentStates>>) => {
      const c = createInitialConversationState("c1", business, "x");
      appendLedger(c, { operation: "createBooking", describes: "appointment booking", terms: {}, effect: "createBooking.failed", status: "failed" });
      c.knownFields.__effectLedger = JSON.stringify(JSON.parse(c.knownFields.__effectLedger).map((e: { at: string }) => ({ ...e, at: failAt })));
      return deriveIncidents({ graph, conversations: [c], approvals: [], payments: [], connections: [], ai: ai(), now: NOW, states })[0];
    };
    const key = "failed_write:c1:createBooking";
    expect(derive(hoursAgo(3), [])).toMatchObject({ key, status: "current" });
    await setIncidentState(business, key, "acknowledge", { by: "founder", note: "looking", now: NOW });
    expect(derive(hoursAgo(3), await loadIncidentStates(business))).toMatchObject({ status: "acknowledged", acknowledged: { by: "founder", note: "looking" } });
    await setIncidentState(business, key, "resolve", { by: "founder", now: new Date(NOW.getTime() - 3600_000) });
    expect(derive(hoursAgo(3), await loadIncidentStates(business)).status).toBe("resolved");
    // The same failure happens again AFTER the resolution: current again.
    expect(derive(hoursAgo(0.5), await loadIncidentStates(business)).status).toBe("current");
  });
});

// ── Fleet ──────────────────────────────────────────────────────────────────────────────────────────

describe("fleet: one status per business, exceptions first", () => {
  it("a business with a pending discount approval shows the intervention, the active approval, the obligation and money with the owner; another tenant sees none of it", async () => {
    const { g, model, id } = setup();
    await midnightInCart(model, g, id);
    model.plan = () => ({ constraints: { discountPct: 10 }, advancesTransaction: true });
    await handleCustomerMessage(g, id, "c", "10% off?");
    const status = await getBusinessStatus(g, { now: new Date(), detail: true });
    expect(status).toMatchObject({ id: g.business.id, interventions: 1, approvalsActive: 1, approvalsHeld: 0, health: "attention", stage: "simulator_only", storage: "memory" });
    expect(status.obligations.needsOwner).toBeGreaterThanOrEqual(1);
    expect(status.interventionQueue[0].refs.approvalId).toBeTruthy();
    expect(status.obligationList.some((o) => o.kind === "approval_blocking_transaction" && o.conversationId === id)).toBe(true);
    const spa = await getBusinessStatus(getBusinessGraph("spa"), { now: new Date() });
    expect(spa.interventionQueue).toEqual([]);
    expect(spa.obligationList).toEqual([]);
    expect(spa.approvalsActive).toBe(0);
  });

  it("the summary lists who needs the founder, what broke, what changed, money blocked and not-ready — from statuses only", () => {
    const base: BusinessStatus = {
      id: "a", name: "A", timezone: "Asia/Jerusalem", health: "healthy", stage: "simulator_only", controls: { ...DEFAULT_CONTROLS }, build: { commit: null, runtime: "x", environment: "test" }, model: { mode: "simulated", model: null, status: "healthy", summary: "" }, storage: "memory", channel: { whatsapp: "missing" }, providers: { commerce: "simulated", payments: "simulated", scheduling: "not used" },
      readiness: { level: "READY_FOR_SUPERVISED_PILOT", label: "Ready for a supervised pilot", blockers: [] }, interventions: 0, approvalsActive: 0, approvalsHeld: 0, handoffsOpen: 0, incidents: { high: 0, medium: 0, low: 0, open: [] }, obligations: { open: 0, needsOwner: 0, barryCanAct: 0, waitingOnCustomer: 0, blocked: 0 },
      money: { stuckWithOwner: {}, waitingOnCustomer: {}, atRisk: {}, simulated: {}, verifiedPayments: 0 }, conversations: { total: 0, last24h: 0, latestActivityAt: null }, recentChanges: [], unavailable: [],
    };
    const inc = { key: "k", businessId: "b", kind: "ai_unavailable" as const, severity: "high" as const, title: "AI down", firstSeen: "2026-01-01", lastSeen: "2026-01-01", occurrences: 1, status: "current" as const, evidence: [], impact: "", nextAction: "", links: {} };
    const s = summarizeFleet([
      base,
      { ...base, id: "b", name: "B", health: "unhealthy", incidents: { high: 1, medium: 0, low: 0, open: [inc] }, money: { ...base.money, stuckWithOwner: { ILS: 390 } } },
      { ...base, id: "c", name: "C", readiness: { level: "NOT_READY", label: "Not ready", blockers: ["Add your products"] }, approvalsHeld: 1 },
    ]);
    expect(s.businesses).toBe(3);
    expect(s.healthy).toBe(2);
    expect(s.needFounder.map((x) => x.id)).toEqual(["b", "c"]);
    expect(s.broke).toHaveLength(1);
    expect(s.moneyBlocked.map((x) => x.id)).toEqual(["b"]);
    expect(s.notReady).toEqual([{ id: "c", name: "C", level: "NOT_READY", blocker: "Add your products" }]);
  });
});

// ── Obligations ────────────────────────────────────────────────────────────────────────────────────

function payment(over: Partial<PaymentRequestRecord> & { id: string; createdAt: string }): PaymentRequestRecord {
  return { businessId: "fashion-retailer", conversationId: "c1", customerId: "x", amount: 390, currency: "ILS", reason: "r", status: "pending", provider: "payplus", ...over };
}

describe("operational obligations: derived from records, reconciled durably, closed with evidence", () => {
  const g = getBusinessGraph("fashion-retailer");
  const c1 = (): ConversationState => {
    const c = createInitialConversationState("c1", g.business.id, "x");
    c.knownFields.name = "Adi";
    return c;
  };

  it("derivation: a fresh unpaid link waits on the customer; after a day it needs the owner; an active approval needs the owner with its approval id; an open handoff needs the owner", () => {
    const fresh = deriveObligations({ graph: g, conversations: [c1()], approvals: [], payments: [payment({ id: "p1", createdAt: hoursAgo(2) })], bookings: [], now: NOW });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ key: "unpaid_payment_followup:p1", kind: "unpaid_payment_followup", customer: "Adi", nextMove: "waiting_on_customer", status: "waiting_on_customer", owner: "customer", amount: 390, currency: "ILS", simulated: false });
    const stale = deriveObligations({ graph: g, conversations: [c1()], approvals: [], payments: [payment({ id: "p1", createdAt: hoursAgo(30) })], bookings: [], now: NOW });
    expect(stale[0]).toMatchObject({ nextMove: "needs_owner", status: "actionable", owner: "owner", dueAt: new Date(Date.parse(hoursAgo(30)) + 24 * 3600_000).toISOString() });
    const withApproval = deriveObligations({ graph: g, conversations: [c1()], approvals: withLifecycle([approval({ id: "ap1", createdAt: hoursAgo(1) })], new Map([["c1", c1()]])), payments: [], bookings: [], now: NOW });
    expect(withApproval[0]).toMatchObject({ kind: "approval_blocking_transaction", approvalId: "ap1", authority: "owner_approval", nextMove: "needs_owner", amount: 500 });
  });

  it("reconcile: created once (no duplicate on the second pass), updated when its state changes, completed with evidence when the payment is verified, cancelled when it fails", async () => {
    const business = `${g.business.id}-obl-${Date.now()}`;
    const graph = { ...g, business: { ...g.business, id: business } };
    const c = c1();
    const p = payment({ id: `p_${business}`, businessId: business, createdAt: hoursAgo(2) });
    const first = await reconcileObligations({ graph, conversations: [c], approvals: [], payments: [p], bookings: [], now: NOW });
    expect(first.map((o) => [o.key, o.status])).toEqual([[`unpaid_payment_followup:${p.id}`, "waiting_on_customer"]]);
    const again = await reconcileObligations({ graph, conversations: [c], approvals: [], payments: [p], bookings: [], now: NOW });
    expect(again).toHaveLength(1);
    expect((await getBackend().listOperatorRecords(business, "obligation"))).toHaveLength(1);
    // A day later: the same obligation, now actionable for the owner (updated in place).
    const later = new Date(NOW.getTime() + 30 * 3600_000);
    const aged = await reconcileObligations({ graph, conversations: [c], approvals: [], payments: [p], bookings: [], now: later });
    expect(aged[0]).toMatchObject({ key: `unpaid_payment_followup:${p.id}`, status: "actionable", nextMove: "needs_owner", createdAt: NOW.toISOString() });
    // The provider verifies the payment: completed, with the record as evidence.
    const paidAt = new Date(later.getTime() + 60_000).toISOString();
    const done = await reconcileObligations({ graph, conversations: [c], approvals: [], payments: [{ ...p, status: "paid", verifiedAt: paidAt }], bookings: [], now: new Date(later.getTime() + 120_000) });
    expect(done[0]).toMatchObject({ status: "completed", completion: { at: paidAt, evidence: expect.stringMatching(/verified paid/) } });
    expect(done.filter(isOpen)).toEqual([]);
    // Another link that fails is cancelled, not completed.
    const p2 = payment({ id: `p2_${business}`, businessId: business, createdAt: hoursAgo(1) });
    await reconcileObligations({ graph, conversations: [c], approvals: [], payments: [p2], bookings: [], now: NOW });
    const failed = await reconcileObligations({ graph, conversations: [c], approvals: [], payments: [{ ...p2, status: "failed" }], bookings: [], now: NOW });
    expect(failed.find((o) => o.key === `unpaid_payment_followup:${p2.id}`)).toMatchObject({ status: "cancelled", cancellation: { reason: "payment failed" } });
  });

  it("approvals: declined → cancelled; a newer revision → superseded (pointing at the new one); approved → completed", async () => {
    const business = `${g.business.id}-obl2-${Date.now()}`;
    const graph = { ...g, business: { ...g.business, id: business } };
    const c = c1();
    const states = new Map([["c1", c]]);
    const a1 = approval({ id: `a1_${business}`, businessId: business, createdAt: hoursAgo(3) });
    await reconcileObligations({ graph, conversations: [c], approvals: withLifecycle([a1], states), payments: [], bookings: [], now: NOW });
    const declined = await reconcileObligations({ graph, conversations: [c], approvals: withLifecycle([{ ...a1, status: "declined", resolution: { decision: "declined", decidedAt: NOW.toISOString(), decidedBy: "owner" } }], states), payments: [], bookings: [], now: NOW });
    expect(declined[0]).toMatchObject({ status: "cancelled", cancellation: { reason: "request declined" } });
    const a2 = approval({ id: `a2_${business}`, businessId: business, createdAt: hoursAgo(2) });
    const a3 = approval({ id: `a3_${business}`, businessId: business, createdAt: hoursAgo(1) });
    await reconcileObligations({ graph, conversations: [c], approvals: withLifecycle([a2], states), payments: [], bookings: [], now: NOW });
    const superseded = await reconcileObligations({ graph, conversations: [c], approvals: withLifecycle([{ ...a2, status: "declined", resolution: { decision: "declined", decidedAt: NOW.toISOString(), decidedBy: "runtime:superseded" } }, a3], states), payments: [], bookings: [], now: NOW });
    expect(superseded.find((o) => o.approvalId === a2.id)).toMatchObject({ status: "superseded", supersededBy: `approval_blocking_transaction:${a3.id}` });
    expect(superseded.find((o) => o.approvalId === a3.id)).toMatchObject({ status: "waiting_on_owner" });
    const approved = await reconcileObligations({ graph, conversations: [c], approvals: withLifecycle([{ ...a3, status: "approved", resolution: { decision: "approved", decidedAt: NOW.toISOString(), decidedBy: "owner" } }], states), payments: [], bookings: [], now: NOW });
    expect(approved.find((o) => o.approvalId === a3.id)).toMatchObject({ status: "completed", completion: { evidence: expect.stringMatching(/approved/) } });
  });

  it("runtime: a handoff creates an obligation; resolving it completes the obligation with evidence; nothing is duplicated across passes", async () => {
    const g2 = buildLogisticsDemoGraph();
    setReasonerForTests(new ScriptedModel(() => ({ handoff: { reason: "wants a person", urgency: "normal" }, advancesTransaction: false })));
    const id = conv("ho");
    await handleCustomerMessage(g2, id, "c", "I want to talk to a human");
    const s1 = await getBusinessStatus(g2, { now: new Date(), detail: true });
    const ob = s1.obligationList.find((o) => o.kind === "unresolved_handoff" && o.conversationId === id)!;
    expect(ob).toMatchObject({ nextMove: "needs_owner", status: "waiting_on_owner" });
    const state = (await getConversationStore().get(id))!;
    const { resolveHandoff } = await import("@/lib/runtime/handoff");
    resolveHandoff(state, ob.key.slice("unresolved_handoff:".length), "owner");
    await getConversationStore().save(state);
    const s2 = await getBusinessStatus(g2, { now: new Date(), detail: true });
    expect(s2.obligationList.filter((o) => o.key === ob.key)).toHaveLength(1);
    expect(s2.obligationList.find((o) => o.key === ob.key)).toMatchObject({ status: "completed", completion: { evidence: expect.stringMatching(/resolved/) } });
  });
});

// ── Ask HQ, release state, launch gate ─────────────────────────────────────────────────────────────

describe("Ask HQ BARRY, the release state machine and the design-partner gate", () => {
  it("Ask HQ answers from the fleet briefing; a model answer with a figure not in the briefing is replaced by the summary", async () => {
    const plain = await askHq("Who needs me?");
    expect(plain.source).toBe("briefing");
    expect(plain.answer).toMatch(/businesses healthy/);
    expect(plain.answer).toMatch(/Last Work verdict/);
    expect(plain.links.businesses.some((b) => b.id === "fashion-retailer")).toBe(true);
    const fake = { chat: { completions: { create: async () => ({ choices: [{ message: { content: "17 businesses are down and I paused Rina." } }] }) } } };
    const checked = await askHq("Who needs me?", { client: fake as never, fleet: plain.briefing ? undefined : undefined });
    expect(checked.source).toBe("briefing");
    expect(checked.reason).toMatch(/couldn't be verified/);
  });

  it("release: tests never produce LIVE PASSED; only a recorded Work verdict for THIS sha does; a blocked verdict blocks", async () => {
    const m = ACCEPTANCE_MANIFEST;
    expect(releaseState(m, null, "abc1234")).toBe("LIVE_PROOF_REQUIRED");
    expect(releaseState(m, { sha: "other", verdict: "passed", at: "2026-01-01", by: "founder" }, "abc1234")).toBe("LIVE_PROOF_REQUIRED");
    expect(releaseState(m, { sha: "abc1234", verdict: "passed", at: "2026-01-01", by: "founder" }, "abc1234")).toBe("LIVE_PASSED");
    expect(releaseState(m, { sha: "abc1234", verdict: "blocked", at: "2026-01-01", by: "founder" }, "abc1234")).toBe("BLOCKED");
    expect(releaseState({ ...m, knownBlockers: ["P0 open"] }, { sha: "abc1234", verdict: "passed", at: "2026-01-01", by: "founder" }, "abc1234")).toBe("BLOCKED");
    expect(releaseState({ ...m, liveProofRequired: [] }, null, null)).toBe("LOCALLY_PROVEN");
    const prev = process.env.BARRY_COMMIT_SHA;
    process.env.BARRY_COMMIT_SHA = `sha-${Date.now()}`;
    try {
      expect((await currentRelease()).state).toBe("LIVE_PROOF_REQUIRED");
      await recordWorkVerdict({ sha: process.env.BARRY_COMMIT_SHA, verdict: "passed", by: "founder", note: "8/8" });
      const r = await currentRelease();
      expect(r.state).toBe("LIVE_PASSED");
      expect(r.gates.find((g) => g.id === "live_model")?.status).toBe("pass");
      expect(r.nextProofRequired).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.BARRY_COMMIT_SHA;
      else process.env.BARRY_COMMIT_SHA = prev;
    }
  });

  it("launch gate: Rina on simulators is NOT READY with evidence per item; unknown items stay unknown; supervision mode is one required item", async () => {
    const g = getBusinessGraph("fashion-retailer");
    const gate = await launchChecklist(g, { controls: { ...DEFAULT_CONTROLS } });
    expect(gate.level).toBe("NOT_READY");
    const byId = Object.fromEntries(gate.items.map((i) => [i.id, i]));
    expect(byId["founder.supervision"]).toMatchObject({ status: "blocked", responsibility: "founder", requiredForSupervised: true });
    expect(byId["commerce.provider"]).toMatchObject({ status: "blocked" });
    expect(byId["knowledge.policies"]).toMatchObject({ status: "ready" });
    expect(byId["qa.live_proof"].status).toMatch(/unknown|blocked|ready/);
    for (const i of gate.items) expect(i.evidence.length).toBeGreaterThan(0);
    const supervised = await launchChecklist(g, { controls: { ...DEFAULT_CONTROLS, mode: "supervised", updatedAt: NOW.toISOString(), updatedBy: "founder", reason: "pilot" } });
    expect(supervised.items.find((i) => i.id === "founder.supervision")).toMatchObject({ status: "ready" });
    expect(supervised.level).toBe("NOT_READY"); // other required items still blocked — never promoted by one control
  });
});
