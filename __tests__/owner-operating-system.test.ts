import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import "@/lib/fabric";
import { buildLogisticsDemoGraph, demoHelpdeskTickets, resetDemoHelpdeskForTests } from "@/lib/fixtures/logistics-demo";
import { getBusinessGraph } from "@/lib/fixtures";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { getConversationStore, createInitialConversationState, type ConversationState } from "@/lib/state";
import { appendLedger, readLedger } from "@/lib/runtime/ledger";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { resolveHandoff } from "@/lib/runtime/handoff";
import { CHANNEL_DELIVERY_KEY } from "@/lib/channels/gateway";
import { setReasonerForTests, type BarryIR } from "@/lib/reasoner";
import { getBackend } from "@/lib/store";
import type { ApprovalRecord, BookingRecord, PaymentRequestRecord } from "@/lib/store/types";
import { conversationStory, describeEffect } from "@/lib/owner/story";
import { buildInterventions, interventionBriefing, whyApproval } from "@/lib/owner/interventions";
import { revenueOpportunities } from "@/lib/owner/opportunities";
import { getOwnerWorkspace, customerLabel } from "@/lib/owner/service";
import { getOwnerConversation } from "@/lib/owner/conversation";
import { askOwnerBarry } from "@/lib/owner/ask";
import { DecisionSheet } from "@/components/owner/views/decision";
import { WorkView } from "@/components/owner/views/Work";
import { MoneyView } from "@/components/owner/views/Money";
import { ScriptedModel, approvalsOf, conv, isolatedRetailer, ticket } from "./support/scripted-model";

/**
 * THE OWNER OPERATING MODEL: one intervention queue (why / what BARRY did / the decision / what
 * follows / still current), the conversation story it is built from, and revenue opportunities with
 * their next move. Everything is derived from records; nothing here is model prose.
 */

let dispose: (() => void) | undefined;
afterEach(() => {
  setReasonerForTests(undefined);
  resetDemoHelpdeskForTests();
  dispose?.();
  dispose = undefined;
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

// ── Story ────────────────────────────────────────────────────────────────

describe("the conversation story is built from records, turn by turn", () => {
  const C301 = "Parcel Q4-C301 is delayed, open a delay case";

  it("ask → asked the owner → you approved → the case reference; 'tried' lists the consequential steps", async () => {
    const g = buildLogisticsDemoGraph();
    setReasonerForTests(new ScriptedModel((ctx) => (ctx.customerMessage === C301 ? ticket("Q4-C301") : { advancesTransaction: false })));
    const id = conv("story");
    await handleCustomerMessage(g, id, "c", C301);
    const [a] = await approvalsOf(g, id);
    await resumeAfterApproval(g, a.id, "approved", "owner");
    const story = conversationStory((await getConversationStore().get(id))!);
    expect(story.steps.map((s) => s.outcome)).toEqual(["awaiting_owner", "owner_decision"]);
    expect(story.steps[0].customer).toBe(C301);
    expect(story.steps[0].barry[0]).toMatch(/^Asked you to approve: .*Q4-C301/);
    expect(story.steps[0].stopped).toBe("needs your approval");
    expect(story.steps[1].customer).toBe("(you approved the request)");
    expect(story.steps[1].barry.join(" ")).toMatch(/T-1001/);
    expect(story.tried.at(-1)).toMatch(/T-1001/);
    expect(story.standing.join(" ")).toMatch(/T-1001/);
  });

  it("a message BARRY couldn't understand is its own step; owner wording never contains internal ids", () => {
    const state = createInitialConversationState("c-story", "spa", "cust");
    const e = appendLedger(state, { operation: "createPaymentRequest", effect: "payment.link_created", status: "effected", describes: "payment link", terms: { amount: 220, currency: "USD" } });
    expect(describeEffect(e)).toBe("Sent a payment link — $220 — not paid yet");
    const failed = appendLedger(state, { operation: "createBooking", effect: "createBooking.failed", status: "failed", describes: "appointment booking", terms: {} });
    expect(describeEffect(failed)).toMatch(/^Tried appointment booking — it FAILED; nothing changed$/);
    expect(describeEffect({ ...e, status: "awaiting_owner" })).toBe("Asked you to approve: payment link — $220");
    expect(describeEffect({ ...e, effect: "write.blocked", status: "no_effect" })).toMatch(/blocked by the customer's own limits/);
  });
});

// ── Interventions ────────────────────────────────────────────────────────

describe("the intervention queue joins approvals, holds, handoffs, failures, blocks and channel problems", () => {
  const C301 = "Parcel Q4-C301 is delayed, open a delay case";

  async function logisticsWithApproval(planAfter: (msg: string) => Partial<BarryIR> | "FAIL" | undefined = () => ({ advancesTransaction: false })) {
    const g = buildLogisticsDemoGraph();
    setReasonerForTests(new ScriptedModel((ctx) => (ctx.customerMessage === C301 ? ticket("Q4-C301") : planAfter(ctx.customerMessage))));
    const id = conv("iq");
    await handleCustomerMessage(g, id, "c", C301);
    return { g, id };
  }

  it("an active approval: your rule as the why, exact terms, both options with their consequences, and what BARRY resumes", async () => {
    const { g, id } = await logisticsWithApproval();
    const ws = await getOwnerWorkspace(g);
    const item = ws.interventions.find((i) => i.conversationId === id)!;
    expect(item).toMatchObject({ kind: "approval", priority: 1 });
    expect(item.title).toMatch(/^Approve .*Q4-C301.* for /);
    // The authority rule's own reason — never the capability id or rule syntax.
    expect(item.why).toBe("Your rule: Every support case is approved by the owner in this demo.");
    expect(item.why).not.toMatch(/support\.ticket|demo-tickets/);
    expect(item.terms).toMatchObject({ reference: "Q4-C301" });
    expect(item.options.map((o) => o.action)).toEqual(["approve", "decline"]);
    expect(item.options[0].consequence).toMatch(/runs it once/);
    expect(item.options[0].consequence).toMatch(/re-reads what the customer said since/);
    expect(item.options[1].consequence).toMatch(/nothing is sent or changed/i);
    expect(item.then).toMatch(/tells the customer the result, with the reference/);
    expect(item.freshness).toMatch(/^Current/);
    expect(item.tried[0]).toMatch(/Asked you to approve/);
    expect(item.evidence[0]).toMatch(/^request /);
    // The queue and the conversation list agree on who needs the owner.
    expect(ws.today.interventions).toBe(ws.interventions.length);
    expect(ws.conversations.find((c) => c.id === id)?.status).toBe("needs_you");
    // Once decided, it leaves the queue.
    await resumeAfterApproval(g, item.refs.approvalId!, "approved", "owner");
    const after = await getOwnerWorkspace(g);
    expect(after.interventions.find((i) => i.conversationId === id)).toBeUndefined();
    expect(demoHelpdeskTickets()).toHaveLength(1);
  });

  it("a held approval offers re-check (not approve) and says why it isn't current", async () => {
    const { g, id } = await logisticsWithApproval(() => "FAIL");
    await handleCustomerMessage(g, id, "c", "wait, C302 not 301");
    const ws = await getOwnerWorkspace(g);
    const items = ws.interventions.filter((i) => i.conversationId === id);
    // The held request carries the not-understood message; it is not listed twice.
    expect(items.map((i) => i.kind)).toEqual(["held_approval"]);
    const [held] = items;
    expect(held.options.map((o) => o.action)).toEqual(["recheck", "decline"]);
    expect(held.options[0].consequence).toMatch(/corrected request comes back to you/);
    expect(held.why).toMatch(/couldn't understand/);
    expect(held.freshness).toMatch(/^Not current/);
  });

  it("a handoff: the trigger and reason, what to do, acknowledge/resolve consequences, and the honest customer promise", async () => {
    const g = buildLogisticsDemoGraph();
    setReasonerForTests(new ScriptedModel(() => ({ handoff: { reason: "customer wants a person about a destroyed parcel", urgency: "urgent" }, advancesTransaction: false })));
    const id = conv("iq-ho");
    await handleCustomerMessage(g, id, "c", "I want a human, my parcel is destroyed");
    const ws = await getOwnerWorkspace(g);
    const item = ws.interventions.find((i) => i.conversationId === id)!;
    expect(item).toMatchObject({ kind: "handoff", priority: 1 });
    expect(item.title).toMatch(/needs a person — urgent$/);
    expect(item.why).toMatch(/^The customer asked for a person: customer wants a person/);
    expect(item.options.map((o) => o.action)).toEqual(["acknowledge", "resolve"]);
    expect(item.then).toMatch(/no promised reply time/);
    expect(item.then).toMatch(/can't send your reply for you yet/);
    const state = (await getConversationStore().get(id))!;
    resolveHandoff(state, item.refs.handoffId!, "owner");
    await getConversationStore().save(state);
    expect((await getOwnerWorkspace(g)).interventions.find((i) => i.conversationId === id)).toBeUndefined();
  });

  it("a failed operation is an item until something of that kind succeeds; a blocked checkout says which limit and what unblocks it", () => {
    const g = getBusinessGraph("spa");
    const state = createInitialConversationState("c-fail", "spa", "cust");
    state.messages.push({ role: "customer", content: "book me", at: hoursAgo(2) }, { role: "barry", content: "That didn't go through.", at: hoursAgo(2) });
    const failed = appendLedger(state, { operation: "createBooking", effect: "createBooking.failed", status: "failed", describes: "appointment booking", terms: { offer: "Couples Massage" } });
    state.turns.push({ id: "t1", at: hoursAgo(2), customerMessage: "book me", understood: { intent: "book", entities: {} }, retrieved: { offerIds: [], knowledgeIds: [] }, response: "That didn't go through.", stateAfter: { stage: "scheduling" }, reasoner: "mock", toolResult: { ok: false, error: "calendar timeout" }, trace: { runtime: { barryVersion: "x", commit: null, constitutionVersion: "x", reasoner: "mock", model: null }, rejectedClaims: [], steps: [{ trigger: "customer", action: "createBooking", capabilities: [], policy: { status: "allowed", reason: "" }, result: { ok: false, error: "calendar timeout" }, stageBefore: "scheduling", stageAfter: "scheduling", stateKeysChanged: [] }], stop: { reason: "tool_failed", outcome: "createBooking" }, effects: [{ seq: failed.seq, operation: failed.operation, effect: failed.effect, status: failed.status, terms: failed.terms }] } });
    const blockedState = createInitialConversationState("c-block", "spa", "cust2");
    blockedState.messages.push({ role: "customer", content: "up to 100 incl shipping", at: hoursAgo(1) }, { role: "barry", content: "I can't promise the total.", at: hoursAgo(1) });
    appendLedger(blockedState, { operation: "createPaymentRequest", effect: "write.blocked", status: "no_effect", describes: "payment link", terms: { amount: 120, currency: "USD" }, outcome: { reason: "shipping_unknown", total: 120, cap: 100 } });
    const items = buildInterventions({ graph: g, conversations: [state, blockedState], approvals: [], payments: [], customerLabel });
    const fail = items.find((i) => i.kind === "failed_action")!;
    expect(fail.title).toMatch(/^Appointment booking failed for /);
    expect(fail.why).toBe("The system reported: calendar timeout");
    expect(fail.decision).toMatch(/BARRY did not retry/);
    const block = items.find((i) => i.kind === "blocked_write")!;
    expect(block).toMatchObject({ priority: 3, amount: "$120" });
    expect(block.why).toMatch(/budget of \$100 including shipping/);
    expect(block.decision).toMatch(/shipping fee/);
    // A later success of the same operation retires the failure.
    appendLedger(state, { operation: "createBooking", effect: "booking.created", status: "effected", describes: "appointment booking", terms: {}, reference: "BK-1" });
    expect(buildInterventions({ graph: g, conversations: [state], approvals: [], payments: [], customerLabel }).some((i) => i.kind === "failed_action")).toBe(false);
  });

  it("a not-understood last message and a failed delivery are items; quota exhaustion is priority 1 with the fix", () => {
    const g = getBusinessGraph("spa");
    const state = createInitialConversationState("c-nu", "spa", "cust");
    state.messages.push({ role: "customer", content: "hi", at: hoursAgo(1) }, { role: "barry", content: "Sorry, couldn't process that.", at: hoursAgo(1) });
    state.turns.push({ id: "t1", at: hoursAgo(1), customerMessage: "hi", understood: { intent: "understanding_failed", entities: {} }, retrieved: { offerIds: [], knowledgeIds: [] }, response: "Sorry", stateAfter: { stage: "discovery" }, reasoner: "llm", trace: { runtime: { barryVersion: "x", commit: null, constitutionVersion: "x", reasoner: "llm", model: "m" }, rejectedClaims: [], steps: [], stop: { reason: "understanding_unavailable", outcome: "provider_quota_exhausted" }, understanding: { valid: false, attempts: 1, latencyMs: 1, failure: { kind: "provider_quota_exhausted", transient: false } } } });
    state.knownFields[CHANNEL_DELIVERY_KEY] = JSON.stringify([{ at: hoursAgo(1), channel: "whatsapp", inboundId: "m1", status: "failed", error: "Graph API 401" }]);
    const items = buildInterventions({ graph: g, conversations: [state], approvals: [], payments: [], customerLabel });
    expect(items.map((i) => i.kind)).toEqual(["not_understood", "delivery_failed"]);
    expect(items[0]).toMatchObject({ priority: 1 });
    expect(items[0].why).toMatch(/out of credit/);
    expect(items[0].decision).toMatch(/Add credit/);
    expect(items[1].why).toMatch(/WhatsApp reported: Graph API 401/);
  });

  it("whyApproval speaks the owner's rule for Genome policies (limits in money, discounts in %)", () => {
    const g = getBusinessGraph("fashion-retailer");
    const base = { id: "a", businessId: g.business.id, conversationId: "c", customerId: "x", requestedAction: "createCommerceCheckout", requestedInput: { amount: 2480, currency: "ILS" }, reason: "Order total 2480 exceeds automatic limit of 2000.", status: "pending" as const, createdAt: new Date().toISOString() };
    const [a] = withLifecycle([{ ...base, policyId: "max_auto_payment_amount" }], new Map());
    expect(whyApproval(g, a)).toBe("Above your automatic payment limit of ₪2000.");
    const [d] = withLifecycle([{ ...base, policyId: "max_auto_discount_pct", requestedAction: "createPaymentRequest" }], new Map());
    expect(whyApproval(g, d)).toBe("Above the 5% discount BARRY may give on its own.");
    const briefing = interventionBriefing(buildInterventions({ graph: g, conversations: [], approvals: [a], payments: [], customerLabel }));
    expect(briefing[0]).toMatchObject({ kind: "approval", amount: "₪2480" });
    expect(briefing[0].ifApproved).toMatch(/sends the payment link for ₪2480/);
  });
});

// ── Opportunities ────────────────────────────────────────────────────────

describe("revenue opportunities say where money is stuck and whose move it is", () => {
  const g = getBusinessGraph("spa");
  const pay = (over: Partial<PaymentRequestRecord>): PaymentRequestRecord => ({ id: `pay_${Math.random().toString(36).slice(2)}`, businessId: "spa", conversationId: "c1", customerId: "x", amount: 220, currency: "USD", reason: "r", status: "pending", createdAt: hoursAgo(1), provider: "payplus", ...over });
  const convo = (id: string, over: Partial<ConversationState> = {}): ConversationState => ({ ...createInitialConversationState(id, "spa", "x"), ...over });
  const base = { graph: g, conversations: [] as ConversationState[], approvals: [], payments: [] as PaymentRequestRecord[], bookings: [] as BookingRecord[], orders: [], customerLabel };

  it("a fresh link waits on the customer; an old one is the owner's follow-up and at risk; a paid link is no opportunity", () => {
    const paid = pay({ conversationId: "c3", status: "paid", verifiedAt: hoursAgo(0.5) });
    const { items, summary } = revenueOpportunities({ ...base, payments: [pay({ conversationId: "c1" }), pay({ conversationId: "c2", createdAt: hoursAgo(50), amount: 120 }), pay({ conversationId: "c3", createdAt: hoursAgo(3) }), paid] });
    expect(items.map((i) => [i.kind, i.next.who, i.recoverable])).toEqual([
      ["unpaid_link", "customer", false],
      ["unpaid_link", "you", true],
    ]);
    expect(summary).toMatchObject({ waitingOnCustomer: { USD: 220 }, stuckWithYou: { USD: 120 }, atRisk: { USD: 120 }, items: 2 });
    expect(items[1].evidence[0]).toMatch(/^payment request /);
    expect(items[1].next.action).toMatch(/BARRY can't send reminders yet/);
  });

  it("a failed payment is recoverable; simulated money is listed but never counted", () => {
    const { items, summary } = revenueOpportunities({ ...base, payments: [pay({ status: "failed", amount: 300 }), pay({ conversationId: "c9", provider: "memory", amount: 50 })] });
    expect(items.find((i) => i.kind === "payment_failed")).toMatchObject({ recoverable: true, next: { who: "you" } });
    expect(items.find((i) => i.conversationId === "c9")).toMatchObject({ simulated: true });
    expect(summary).toMatchObject({ stuckWithYou: { USD: 300 }, atRisk: { USD: 300 }, waitingOnCustomer: {}, simulatedItems: 1 });
  });

  it("an approval with money is a sale waiting on the owner, linked to its queue item; a held one asks for a re-check first", () => {
    const rec = (id: string): ApprovalRecord => ({ id, businessId: "spa", conversationId: "c1", customerId: "x", requestedAction: "createPaymentRequest", requestedInput: { amount: 220, currency: "USD" }, reason: "over limit", policyId: "max_auto_payment_amount", status: "pending", createdAt: hoursAgo(1) });
    const approvals = withLifecycle([rec("ap1")], new Map());
    const { items, summary } = revenueOpportunities({ ...base, approvals });
    expect(items[0]).toMatchObject({ kind: "approval_blocking_sale", amount: 220, next: { who: "you", interventionId: "approval:ap1" } });
    expect(summary.stuckWithYou).toEqual({ USD: 220 });
  });

  it("a booking without its deposit is a no-show exposure; a stalled purchase names what BARRY is waiting for", () => {
    const booking: BookingRecord = { id: "bk1", businessId: "spa", offerId: g.offers[0].id, resourceId: "therapist-1", start: hoursAgo(-48), end: hoursAgo(-47), customerId: "x", conversationId: "c1", partySize: 2, status: "confirmed", createdAt: hoursAgo(3), provider: "google" };
    const stalled = convo("c5", { selectedOfferId: g.offers[0].id, missingFields: ["phone"] });
    stalled.knownFields.__purchaseDecided = "1";
    stalled.messages.push({ role: "customer", content: "I'll take the couples massage", at: hoursAgo(30) }, { role: "barry", content: "Great — what's your phone number?", at: hoursAgo(30) });
    const { items } = revenueOpportunities({ ...base, bookings: [booking], conversations: [stalled] });
    const deposit = items.find((i) => i.kind === "unpaid_deposit")!;
    expect(deposit).toMatchObject({ amount: g.offers[0].depositAmount, currency: "USD", next: { who: "you" } });
    expect(deposit.reasoning).toMatch(/deposit hasn't been paid/);
    const s = items.find((i) => i.kind === "stalled_purchase")!;
    expect(s).toMatchObject({ amount: g.offers[0].price, recoverable: true });
    expect(s.reasoning).toMatch(/asked for phone and the customer hasn't answered/);
  });

  it("a stalled purchase that already has a link, a pending request, or a reply from the customer is not double-counted", () => {
    const c = convo("c6", { selectedOfferId: g.offers[0].id });
    c.knownFields.__purchaseDecided = "1";
    c.messages.push({ role: "barry", content: "Which time?", at: hoursAgo(30) }, { role: "customer", content: "tomorrow", at: hoursAgo(29) });
    expect(revenueOpportunities({ ...base, conversations: [c] }).items).toEqual([]);
    const quiet = convo("c7", { selectedOfferId: g.offers[0].id });
    quiet.knownFields.__purchaseDecided = "1";
    quiet.messages.push({ role: "customer", content: "ok", at: hoursAgo(31) }, { role: "barry", content: "Here's your link", at: hoursAgo(30) });
    const { items } = revenueOpportunities({ ...base, conversations: [quiet], payments: [pay({ conversationId: "c7", createdAt: hoursAgo(30) })] });
    expect(items.map((i) => i.kind)).toEqual(["unpaid_link"]);
  });
});

// ── End to end: workspace, conversation detail, Owner Barry ───────────────

describe("the owner surfaces read the same models", () => {
  it("the inbox detail carries the story; Owner Barry's briefing carries the queue and the stuck money", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const { g } = r;
    setReasonerForTests(new ScriptedModel(() => ({ advancesTransaction: false })));
    const id = conv("e2e");
    await handleCustomerMessage(g, id, "c", "hello");
    const detail = (await getOwnerConversation(g, id))!;
    expect(detail.story.steps).toHaveLength(1);
    expect(detail.story.steps[0]).toMatchObject({ customer: "hello", outcome: "answered" });
    const backend = getBackend();
    await backend.createPaymentRequest({ businessId: g.business.id, conversationId: id, customerId: "c", amount: 390, currency: "ILS", reason: "order", provider: "payplus" });
    const out = await askOwnerBarry(g, "Where is money stuck?");
    expect(out.source).toBe("briefing");
    expect(out.briefing.moneyInMotion.waitingOnCustomer).toBe("₪390");
    expect(out.briefing.moneyInMotion.items[0]).toMatchObject({ kind: "unpaid link", amount: "₪390" });
    expect(out.answer).toMatch(/Money in motion/);
    // The queue in the briefing is the same queue the dashboard shows.
    const ws = await getOwnerWorkspace(g);
    expect(out.briefing.waitingForYou).toHaveLength(ws.interventions.length);
    expect(readLedger((await getConversationStore().get(id))!)).toBeDefined();
  });
});

// ── The components render what the models say ─────────────────────────────

describe("the Owner OS views render the models (server render)", () => {
  it("queue cards show why / you decide / then / options with consequences; money in motion shows whose move; the story shows each step", async () => {
    const g = buildLogisticsDemoGraph();
    setReasonerForTests(new ScriptedModel((ctx) => (ctx.customerMessage.startsWith("Parcel") ? ticket("Q4-C301") : { advancesTransaction: false })));
    const id = conv("render");
    await handleCustomerMessage(g, id, "c", "Parcel Q4-C301 is delayed, open a delay case");
    const ws = await getOwnerWorkspace(g);
    const item = ws.interventions.find((i) => i.conversationId === id)!;
    const sheet = renderToString(createElement(DecisionSheet, { item, onClose: () => undefined, act: () => undefined, busy: false, onConversation: () => undefined }));
    expect(sheet).toMatch(/Your approval/);
    expect(sheet).toMatch(/Approve open a support case/i);
    expect(sheet).toMatch(/Why it&#x27;s with you/);
    expect(sheet).toMatch(/Every support case is approved by the owner/);
    expect(sheet).toMatch(/Decline/);
    expect(sheet).toMatch(/Current: nothing the customer said since/);
    const empty = renderToString(createElement(WorkView, { ws: { ...ws, interventions: [], ownerOperations: [], obligations: [], initiatives: [] }, onDecision: () => undefined, onOpen: () => undefined, onInitiative: async () => undefined, onAsk: () => undefined }));
    expect(empty).toMatch(/Nothing needs you/);
    const opp = { id: "o1", kind: "unpaid_link" as const, customer: "Adi", conversationId: "c", since: hoursAgo(30), ageHours: 30, amount: 390, currency: "ILS", simulated: false, evidence: ["payment request x"], reasoning: "Unpaid for a day.", next: { who: "you" as const, action: "Follow up." }, recoverable: true };
    const money = renderToString(createElement(MoneyView, { ws: { ...ws, opportunities: { items: [opp], summary: { stuckWithYou: { ILS: 390 }, waitingOnCustomer: {}, atRisk: { ILS: 390 }, items: 1, simulatedItems: 0, simulated: {} } } } as typeof ws, range: "today", setRange: () => undefined, onOpen: () => undefined }));
    expect(money).toMatch(/Payment link not paid/);
    expect(money).toMatch(/Your move/);
    expect(money).toMatch(/At risk/);
    const story = JSON.stringify(conversationStory((await getConversationStore().get(id))!));
    expect(story).toMatch(/needs your approval/);
    expect(story).toMatch(/Asked you to approve/);
  });
});
