import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import "@/lib/fabric";
import { buildLogisticsDemoGraph, demoHelpdeskTickets, resetDemoHelpdeskForTests } from "@/lib/fixtures/logistics-demo";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { ConversationScopeError, getConversationStore, createInitialConversationState, type ConversationState } from "@/lib/state";
import { readLedger } from "@/lib/runtime/ledger";
import { askOutcomes } from "@/lib/runtime/ask-outcomes";
import { composeDeterministic } from "@/lib/reasoner/deterministic-compose";
import { setReasonerForTests, type AskOutcome, type BarryIR, type PolicyContradiction, type ReasonerContext } from "@/lib/reasoner";
import { simulatorView, scopeKey, type SimulatorData } from "@/lib/simulator-session";
import { recoveryChains } from "@/lib/inspector/recovery-chain";
import { revenueSummary, revenueEvidence } from "@/lib/owner/revenue";
import { askOwnerBarry } from "@/lib/owner/ask";
import { getBusinessGraph } from "@/lib/fixtures";
import { getBackend } from "@/lib/store";
import type { ApprovalRecord, PaymentRequestRecord } from "@/lib/store/types";
import type { BusinessGraph } from "@/lib/business-graph";
import { ScriptedModel, approvalsOf, conv, isolatedRetailer, ticket } from "./support/scripted-model";

/**
 * Regressions for the live acceptance findings on f5aafef (1 High, 2 Medium) and the small unverified
 * legs. Structure and state — never the live wording.
 */

let dispose: (() => void) | undefined;
afterEach(() => {
  setReasonerForTests(undefined);
  resetDemoHelpdeskForTests();
  dispose?.();
  dispose = undefined;
});

const LOGI = "barry-logistics-demo";
const json = (url: string, body: unknown) => new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const get = (url: string) => new NextRequest(url);

// ── FINDING 1 (High): business selection binds every business-scoped surface ──────────────────

describe("F1: a conversation is only ever shown or continued under its own business", () => {
  type Data = SimulatorData<ConversationState, ApprovalRecord, BusinessGraph>;
  const rinaGraph = getBusinessGraph("fashion-retailer");
  const logiGraph = getBusinessGraph(LOGI);
  const rinaState = (): ConversationState => {
    const s = createInitialConversationState("conv_rina", "fashion-retailer", "cust_r");
    s.messages.push({ role: "customer", content: "Midnight M to the cart", at: new Date().toISOString() });
    s.knownFields.__commerceCartId = "cart_rina";
    return s;
  };
  const rinaApproval = { id: "ap_r", businessId: "fashion-retailer", conversationId: "conv_rina", status: "pending" } as ApprovalRecord;
  const loaded: Data = {
    scope: { businessId: "fashion-retailer", conversationId: "conv_rina", customerId: "cust_r" },
    conversation: { businessId: "fashion-retailer", conversationId: "conv_rina", state: rinaState() },
    approvals: { businessId: "fashion-retailer", list: [rinaApproval], locked: false },
    graph: { businessId: "fashion-retailer", graph: rinaGraph },
  };

  it("Rina conversation → switch to Logistics → no Rina conversation, cart, approvals, Inspector data or graph is visible", () => {
    const shownForRina = simulatorView(loaded, "fashion-retailer");
    expect(shownForRina.state?.messages).toHaveLength(1);
    expect(shownForRina.approvals).toHaveLength(1);
    // The selector changed; nothing has reloaded yet — the old business's data is already hidden.
    const afterSwitch = simulatorView(loaded, LOGI);
    expect(afterSwitch).toEqual({ scope: null, state: null, approvals: [], approvalsLocked: false, graph: null });
    // A late response for the old business arriving after the switch is still never shown.
    const late: Data = { ...loaded, scope: { businessId: LOGI, conversationId: "conv_logi", customerId: "c" } };
    expect(simulatorView(late, LOGI).state).toBeNull();
    expect(simulatorView(late, LOGI).approvals).toEqual([]);
    expect(simulatorView(late, LOGI).graph).toBeNull();
  });

  it("Logistics conversation → switch back to Rina → Logistics state never renders under Rina (even if mis-tagged)", () => {
    const logiState = createInitialConversationState("conv_logi", LOGI, "c");
    logiState.messages.push({ role: "customer", content: "Q4-C301 delayed", at: new Date().toISOString() });
    const logi: Data = {
      scope: { businessId: LOGI, conversationId: "conv_logi", customerId: "c" },
      conversation: { businessId: LOGI, conversationId: "conv_logi", state: logiState },
      approvals: { businessId: LOGI, list: [{ ...rinaApproval, businessId: LOGI, id: "ap_l" }], locked: false },
      graph: { businessId: LOGI, graph: logiGraph },
    };
    expect(simulatorView(logi, LOGI).state?.id).toBe("conv_logi");
    expect(simulatorView(logi, "fashion-retailer")).toMatchObject({ state: null, approvals: [], graph: null });
    // Defence in depth: a record tagged for Rina but whose own business is Logistics is not rendered.
    const mislabeled: Data = { ...logi, scope: { ...logi.scope!, businessId: "fashion-retailer" }, conversation: { ...logi.conversation!, businessId: "fashion-retailer" } };
    expect(simulatorView(mislabeled, "fashion-retailer").state).toBeNull();
    expect(scopeKey(logi.scope)).not.toBe(scopeKey(loaded.scope));
  });

  it("foreign business + conversation id is refused on every simulator API — never cross-loaded or continued", async () => {
    setReasonerForTests(new ScriptedModel(() => ({ advancesTransaction: false })));
    const id = conv("rina-owned");
    await handleCustomerMessage(rinaGraph, id, "c", "hello");
    const { GET } = await import("@/app/api/simulator/conversation/route");
    const own = await (await GET(get(`http://x/api/simulator/conversation?businessId=fashion-retailer&conversationId=${id}`))).json();
    expect(own.state?.id).toBe(id);
    const foreign = await (await GET(get(`http://x/api/simulator/conversation?businessId=${LOGI}&conversationId=${id}`))).json();
    expect(foreign.state).toBeNull();
    expect((await GET(get(`http://x/api/simulator/conversation?conversationId=${id}`))).status).toBe(400);
    const { POST: message } = await import("@/app/api/simulator/message/route");
    const hijack = await message(json("http://x", { businessId: LOGI, conversationId: id, customerId: "c", message: "continue as logistics" }));
    expect(hijack.status).toBe(404);
    const { POST: payment } = await import("@/app/api/simulator/payment/route");
    expect((await payment(json("http://x", { businessId: LOGI, conversationId: id, paymentRequestId: "p", outcome: "paid" }))).status).toBe(404);
    // The Rina conversation is untouched: one customer message, still Rina's.
    const after = (await getConversationStore().get(id))!;
    expect(after.businessId).toBe("fashion-retailer");
    expect(after.messages.filter((m) => m.role === "customer")).toHaveLength(1);
    await expect(getConversationStore().getOrCreate(id, LOGI, "c")).rejects.toBeInstanceOf(ConversationScopeError);
  });
});

// ── FINDING 2 (Medium): ask completeness survives the claim/policy guard ─────────────────────

class CompletenessModel extends ScriptedModel {
  /** The scripted semantic checks: which reply sentences contradict policy / which asks a reply leaves out. */
  contradicts: (reply: string) => boolean = () => false;
  misses: (reply: string, ask: AskOutcome) => boolean = () => false;
  coverageChecks = 0;
  async checkPolicyConsistency(_ctx: ReasonerContext, reply: string, policies: { topic: string; text: string }[]): Promise<PolicyContradiction[]> {
    return this.contradicts(reply) ? [{ sentence: reply, policy: policies[0]?.text ?? "", why: "limitation turned into a prohibition" }] : [];
  }
  async checkAskCoverage(_ctx: ReasonerContext, reply: string, asks: AskOutcome[]): Promise<number[]> {
    this.coverageChecks++;
    return asks.flatMap((a, i) => (this.misses(reply, a) ? [i] : []));
  }
}

const POLICY_WORDS = /exchanged only|להחלפה|exchange/i;

async function twoLineCart(model: ScriptedModel, g: BusinessGraph, id: string) {
  model.plan = () => ({ commerce: { intent: "search", query: { category: "dress" } }, advancesTransaction: true });
  const search = await handleCustomerMessage(g, id, "c", "black dresses");
  const titles = search.rich?.products?.map((p) => p.title) ?? [];
  const add = (title: string, quantity: number): Partial<BarryIR> => ({ commerce: { intent: "select", reference: { type: "previous_result", index: titles.indexOf(title) }, variant: { size: "M" }, quantity }, purchaseDecision: false, checkoutConsent: false, advancesTransaction: true });
  model.plan = () => add("Midnight Wrap Dress", 1);
  await handleCustomerMessage(g, id, "c", "Midnight M to the cart");
  model.plan = () => add("Onyx Slip Dress", 1);
  return handleCustomerMessage(g, id, "c", "and Onyx M too");
}

const MIXED_ASKS = [
  { ask: "remove the Midnight, keep the Onyx", kind: "change" as const, coveredByThisIR: true },
  { ask: "can sale items be exchanged?", kind: "question" as const, coveredByThisIR: false, topic: "returns" },
];

describe("F2: a guard may repair a clause but never drop another recognized ask", () => {
  it("A executes (cart removal), B is grounded (sale policy), B's draft wording is rejected → the reply still reports A AND answers B", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const model = new CompletenessModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("mixed");
    await twoLineCart(model, r.g, id);
    model.plan = () => ({ commerce: { intent: "remove", reference: { type: "cart_line", index: 0 } }, advancesTransaction: true, checkoutConsent: false, asks: MIXED_ASKS });
    // Draft: the removal plus a policy sentence that contradicts the business's text. The regenerated
    // reply fixes the policy by dropping it (the live failure). Both are rejected: the first by policy
    // consistency, the second by completeness.
    let drafts = 0;
    model.write = () => (drafts++ === 0 ? "I removed the Midnight dress. Sale items cannot be exchanged." : "I removed the Midnight dress from your cart.");
    model.contradicts = (reply) => /cannot be exchanged/.test(reply);
    model.misses = (reply, a) => a.kind === "question" && !POLICY_WORDS.test(reply);
    const out = await handleCustomerMessage(r.g, id, "c", "Take the Midnight out and keep the Onyx — and can sale items be exchanged?");
    // A really happened.
    const cart = await r.commerce.getCart(out.state.knownFields.__commerceCartId);
    expect(cart!.lines.map((l) => l.title)).toEqual(["Onyx Slip Dress"]);
    // The final reply reports A truthfully and answers B from the business's own text — and never the contradiction.
    // (the exact live shape: the removal receipt with the real total — now followed by the policy answer)
    expect(out.response).toMatch(/Removed the item from your cart\. Cart total is ₪390\./);
    expect(out.response).toContain("Sale items can be exchanged only.");
    expect(out.response).not.toMatch(/cannot be exchanged/);
    expect(out.turn.trace?.reply?.fallback).toMatch(/policy:.*-> deterministic/);
    expect(out.turn.trace?.asks).toEqual([
      { ask: MIXED_ASKS[0].ask, kind: "change", status: "completed" },
      { ask: MIXED_ASKS[1].ask, kind: "question", status: "answered", topic: "returns" },
    ]);
    expect(model.coverageChecks).toBeGreaterThanOrEqual(2);
  });

  it("a regenerated reply that silently drops B is rejected even when nothing else is wrong with it", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const model = new CompletenessModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("drop");
    await twoLineCart(model, r.g, id);
    model.plan = () => ({ commerce: { intent: "remove", reference: { type: "cart_line", index: 0 } }, advancesTransaction: true, checkoutConsent: false, asks: MIXED_ASKS });
    model.write = () => "I removed the Midnight dress from your cart.";
    model.misses = (reply, a) => a.kind === "question" && !POLICY_WORDS.test(reply);
    const out = await handleCustomerMessage(r.g, id, "c", "remove Midnight; sale exchanges?");
    expect(out.response).toContain("Sale items can be exchanged only.");
    expect(out.turn.trace?.reply?.fallback).toMatch(/completeness: .*can sale items be exchanged/);
  });

  it("a complete, faithful draft passes untouched", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const model = new CompletenessModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("ok");
    await twoLineCart(model, r.g, id);
    model.plan = () => ({ commerce: { intent: "remove", reference: { type: "cart_line", index: 0 } }, advancesTransaction: true, checkoutConsent: false, asks: MIXED_ASKS });
    model.write = () => "I removed the Midnight dress. Sale items can be exchanged (not refunded).";
    model.misses = (reply, a) => a.kind === "question" && !POLICY_WORDS.test(reply);
    const out = await handleCustomerMessage(r.g, id, "c", "remove Midnight; sale exchanges?");
    expect(out.response).toBe("I removed the Midnight dress. Sale items can be exchanged (not refunded).");
    expect(out.turn.trace?.reply?.fallback).toBeUndefined();
  });

  it("reverse: A is BLOCKED (final-write gate), B remains answerable → B is still answered", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const model = new CompletenessModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("blocked");
    await twoLineCart(model, r.g, id);
    const who = { customerInfo: { name: "Adi", phone: "0505550114" }, evidence: { "customerInfo.name": "Adi", "customerInfo.phone": "0505550114" } };
    model.plan = () => ({
      commerce: { intent: "checkout" },
      checkoutConsent: true,
      advancesTransaction: true,
      constraints: { budgetMax: 100, budgetIncludesShipping: false },
      ...who,
      asks: [
        { ask: "check out, up to 100", kind: "change", coveredByThisIR: true },
        { ask: "can sale items be exchanged?", kind: "question", coveredByThisIR: false, topic: "returns" },
      ],
    });
    const out = await handleCustomerMessage(r.g, id, "c", "Check out, max 100 total. Adi 0505550114. Also — sale exchanges?");
    expect(out.state.knownFields.__paymentRequestId).toBeUndefined();
    expect(out.turn.trace?.effects?.map((e) => e.effect)).toContain("write.blocked");
    expect(out.turn.trace?.asks?.map((a) => a.status)).toEqual(["blocked", "answered"]);
    expect(out.response).toContain("Sale items can be exchanged only.");
  });

  it("the same invariant for any combination: booking+question, payment+delivery question, support action+status, several questions", () => {
    const graph = { knowledge: [
      { id: "k1", topic: "cancellation", kind: "policy_text", content: "Cancel up to 24h before for a full refund." },
      { id: "k2", topic: "shipping", kind: "policy_text", content: "Free shipping above ₪399." },
      { id: "k3", topic: "hours", kind: "policy_text", content: "Open Sun–Thu 9:00–18:00." },
    ] } as unknown as BusinessGraph;
    const conversation = { kind: "conversation", stage: "discovery" } as const;
    const allowed = (trigger: "customer" | "continuation" = "customer") => ({ trigger, policy: "allowed" as const, ok: true, blocked: false });
    const cases: { name: string; asks: NonNullable<BarryIR["asks"]>; steps: ReturnType<typeof allowed>[] | { trigger: "customer"; policy: "requires_approval"; ok: boolean; blocked: boolean }[]; expected: string[] }[] = [
      { name: "booking + question", asks: [{ ask: "book Tuesday 10:00", kind: "change", coveredByThisIR: true }, { ask: "cancellation policy?", kind: "question", coveredByThisIR: false, topic: "cancellation" }], steps: [allowed()], expected: ["completed", "answered"] },
      { name: "payment + delivery question", asks: [{ ask: "send me the payment link", kind: "change", coveredByThisIR: true }, { ask: "is shipping free?", kind: "question", coveredByThisIR: false, topic: "shipping" }], steps: [allowed()], expected: ["completed", "answered"] },
      { name: "support action + status", asks: [{ ask: "open a damage case", kind: "change", coveredByThisIR: true }, { ask: "what happened to my earlier case?", kind: "status", coveredByThisIR: false }], steps: [{ trigger: "customer", policy: "requires_approval", ok: false, blocked: false }], expected: ["awaiting_approval", "answered"] },
      { name: "several informational asks (one unknown)", asks: [{ ask: "hours?", kind: "question", coveredByThisIR: true, topic: "hours" }, { ask: "shipping?", kind: "question", coveredByThisIR: false, topic: "shipping" }, { ask: "do you gift wrap?", kind: "question", coveredByThisIR: false }], steps: [], expected: ["answered", "answered", "not_done"] },
    ];
    for (const c of cases) {
      const outcomes = askOutcomes({ graph, asks: c.asks, outcome: conversation, steps: c.steps, notDone: [], handoff: false });
      expect(outcomes.map((o) => o.status), c.name).toEqual(c.expected);
      // The deterministic representation (what any rejected reply falls back to) carries every informational answer.
      const text = composeDeterministic({ outcome: conversation, asks: outcomes, language: { code: "en", basis: "business_locale" } as never });
      for (const o of outcomes) if (o.answer) expect(text, c.name).toContain(o.answer.text);
      for (const o of outcomes) if (o.kind === "question" && o.status === "not_done") expect(text, c.name).toContain(o.ask);
    }
  });

  it("a topic the model names that the business doesn't have is never used as an answer", () => {
    const graph = { knowledge: [{ id: "k", topic: "returns", kind: "policy_text", content: "x" }] } as unknown as BusinessGraph;
    const [o] = askOutcomes({ graph, asks: [{ ask: "warranty?", kind: "question", coveredByThisIR: true, topic: "warranty" }], outcome: { kind: "conversation", stage: "discovery" }, steps: [], notDone: [], handoff: false });
    expect(o).toEqual({ ask: "warranty?", kind: "question", status: "not_done" });
  });
});

// ── FINDING 3 (Medium): F31 recovery keeps the corrected request ────────────────────────────

describe("F3: re-checking a failed correction replays THAT customer turn and handles the corrected request", () => {
  const C302 = "Parcel Q4-C302 arrived damaged, please open a case.";
  const CORRECTION = "Wait, sorry, I mixed them up. It was Q4-C303 and it's actually missing. Please replace the case request with that.";

  async function heldAfterFailedCorrection(recheckPlan: (ctx: ReasonerContext) => Partial<BarryIR> | "FAIL" | undefined, correction = CORRECTION) {
    const g = buildLogisticsDemoGraph();
    const model = new ScriptedModel((ctx) => (ctx.customerMessage === C302 ? ticket("Q4-C302", "damaged_item") : recheckPlan(ctx)));
    setReasonerForTests(model);
    const id = conv("f31");
    await handleCustomerMessage(g, id, "c", C302);
    const [c302] = await approvalsOf(g, id);
    const { POST: arm } = await import("@/app/api/qa/force-understanding-failure/route");
    expect((await arm(json("http://x", { businessId: LOGI, conversationId: id }))).status).toBe(200);
    const failed = await handleCustomerMessage(g, id, "c", correction);
    expect(failed.turn.trace?.understanding).toMatchObject({ valid: false, failure: { kind: "qa_forced_understanding_failure" } });
    expect(failed.turn.trace?.steps).toEqual([]);
    // The failed turn is preserved, immutably, for replay: the raw message, its turn, why, and what was pending.
    const failure = readLedger(failed.state).find((e) => e.effect === "understanding.failed")!;
    expect(failure.failedTurn).toEqual({ conversationId: id, turnId: failed.turn.id, message: correction, reason: "qa_forced_understanding_failure", pendingRequestIds: [c302.id] });
    const { GET: ws } = await import("@/app/api/owner/workspace/route");
    const view = await (await ws(get(`http://x/api/owner/workspace?businessId=${LOGI}`))).json();
    expect(view.approvals.find((a: { id: string }) => a.id === c302.id)).toMatchObject({ lifecycle: "held", actionable: false });
    return { g, id, c302, model };
  }

  async function recheck(approvalId: string) {
    const { POST } = await import("@/app/api/owner/approvals/route");
    return (await (await POST(json("http://x", { businessId: LOGI, approvalId, action: "recheck" }))).json()).recheck;
  }

  it("C302 active → failed C303/missing correction → HELD → successful re-check → C302 superseded, C303/missing active → only C303 can execute", async () => {
    // On re-check the SAME message is understood normally: a correction carrying the corrected case.
    const { g, id, c302 } = await heldAfterFailedCorrection((ctx) => (ctx.customerMessage === CORRECTION ? { ...ticket("Q4-C303", "missing_item"), changesPendingRequest: true } : undefined));
    const result = await recheck(c302.id);
    expect(result).toMatchObject({ revalidated: 1, changedRequests: 1, recovered: [{ outcome: "proposed", operation: "invokeCapability" }] });
    const all = await approvalsOf(g, id);
    expect(all.find((a) => a.id === c302.id)?.status).toBe("declined");
    const active = all.filter((a) => a.status === "pending");
    expect(active).toHaveLength(1);
    const c303 = active[0];
    expect(JSON.stringify(c303.requestedInput)).toContain("Q4-C303");
    expect(JSON.stringify(c303.requestedInput)).toContain("missing_item");
    expect(result.recovered[0].requestId).toBe(c303.id);
    // The customer is told the old one was replaced and the corrected one waits for the owner.
    const state = (await getConversationStore().get(id))!;
    expect(state.messages.at(-1)).toMatchObject({ role: "barry" });
    expect(state.messages.at(-1)!.content).toMatch(/corrected request is waiting for the owner's approval/);
    // Inspector chain: FAILED TURN → HELD → RE-CHECK → RECOVERED → OLD SUPERSEDED → NEW REQUEST.
    const [chain] = recoveryChains(readLedger(state));
    expect(chain).toMatchObject({ message: CORRECTION, reason: "qa_forced_understanding_failure", heldRequestIds: [c302.id], superseded: [c302.id], recheck: { recovered: { outcome: "proposed", requestId: c303.id } } });
    // The C303 request is not held (its intent is the recovered, understood turn), and the workspace shows it ACTIVE.
    const { GET: ws } = await import("@/app/api/owner/workspace/route");
    const view = await (await ws(get(`http://x/api/owner/workspace?businessId=${LOGI}`))).json();
    expect(view.approvals.find((a: { id: string }) => a.id === c303.id)).toMatchObject({ lifecycle: "active", actionable: true });
    // Only C303 can execute: C302 is resolved, and approving C303 creates exactly one ticket for Q4-C303.
    const stale = await resumeAfterApproval(g, c302.id, "approved", "owner");
    expect(demoHelpdeskTickets()).toHaveLength(0);
    expect(stale.turn.trace?.steps ?? []).toEqual([]);
    const done = await resumeAfterApproval(g, c303.id, "approved", "owner");
    const tickets = demoHelpdeskTickets();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ reference: "Q4-C303", reason: "missing_item" });
    // Post-approval receipt: the right subject and reference, and a completion claim that is backed.
    const receipt = readLedger(done.state).filter((e) => e.requestId === c303.id && e.status === "effected").at(-1)!;
    expect(receipt.reference).toBe(tickets[0].ticketId);
    expect(done.response).toContain(tickets[0].ticketId);
    expect(done.response).not.toMatch(/C302/);
  });

  it("failed correction → failed re-check → stays HELD; nothing is superseded or created", async () => {
    const { g, id, c302 } = await heldAfterFailedCorrection(() => "FAIL");
    const result = await recheck(c302.id);
    expect(result).toMatchObject({ revalidated: 0, stillUnresolved: 1, changedRequests: 0, recovered: [] });
    const all = await approvalsOf(g, id);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("pending");
    const { GET: ws } = await import("@/app/api/owner/workspace/route");
    const view = await (await ws(get(`http://x/api/owner/workspace?businessId=${LOGI}`))).json();
    expect(view.approvals.find((a: { id: string }) => a.id === c302.id)).toMatchObject({ lifecycle: "held", actionable: false });
    expect(demoHelpdeskTickets()).toHaveLength(0);
  });

  it("failed unrelated message → re-check proves it unrelated → the C302 request becomes actionable again and executes on its own terms", async () => {
    const UNRELATED = "By the way, what are your opening hours?";
    const { g, id, c302 } = await heldAfterFailedCorrection((ctx) => (ctx.customerMessage === UNRELATED ? { advancesTransaction: false } : undefined), UNRELATED);
    const result = await recheck(c302.id);
    expect(result).toMatchObject({ revalidated: 1, changedRequests: 0, recovered: [{ outcome: "unrelated" }] });
    const { GET: ws } = await import("@/app/api/owner/workspace/route");
    const view = await (await ws(get(`http://x/api/owner/workspace?businessId=${LOGI}`))).json();
    expect(view.approvals.find((a: { id: string }) => a.id === c302.id)).toMatchObject({ lifecycle: "active", actionable: true });
    await resumeAfterApproval(g, c302.id, "approved", "owner");
    expect(demoHelpdeskTickets()).toEqual([expect.objectContaining({ reference: "Q4-C302", reason: "damaged_item" })]);
    expect((await approvalsOf(g, id)).filter((a) => a.status === "pending")).toHaveLength(0);
  });
});

// ── Small unverified legs ────────────────────────────────────────────────────────────────

describe("small legs: post-approval execution, pending-payment revenue, Owner Barry mutation refusal", () => {
  it("awaiting approval → approve → exactly one effect, correct reference/subject, truthful completion claim", async () => {
    const g = buildLogisticsDemoGraph();
    setReasonerForTests(new ScriptedModel(() => ticket("Q4-C302", "damaged_item")));
    const id = conv("post-approval");
    const asked = await handleCustomerMessage(g, id, "c", "Q4-C302 arrived damaged, open a case");
    expect(asked.turn.trace?.effects?.map((e) => e.effect)).toContain("request.awaiting_owner");
    expect(demoHelpdeskTickets()).toHaveLength(0);
    const [req] = await approvalsOf(g, id);
    const done = await resumeAfterApproval(g, req.id, "approved", "owner");
    const again = await resumeAfterApproval(g, req.id, "approved", "owner");
    const tickets = demoHelpdeskTickets();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ reference: "Q4-C302", reason: "damaged_item" });
    const effected = readLedger(done.state).filter((e) => e.requestId === req.id && e.status === "effected");
    expect(effected).toHaveLength(1);
    expect(effected[0]).toMatchObject({ reference: tickets[0].ticketId });
    expect(done.response).toContain(tickets[0].ticketId);
    // The completion claim passed the runtime's own claim grounding (no rejected/replaced reply).
    expect(done.turn.trace?.reply?.fallback ?? "").not.toMatch(/claim grounding/);
    expect(again.turn.trace?.steps ?? []).toEqual([]);
  });

  it("a payment link that is pending (or paid but unverified) is never COLLECTED", () => {
    const graph = getBusinessGraph("fashion-retailer");
    const pay = (over: Partial<PaymentRequestRecord>): PaymentRequestRecord => ({ id: `pay_${Math.random().toString(36).slice(2)}`, businessId: graph.business.id, conversationId: "c1", customerId: "x", amount: 390, currency: "ILS", reason: "r", status: "pending", createdAt: new Date().toISOString(), provider: "payplus", ...over });
    const input = { graph, conversations: [], bookings: [], orders: [], approvals: [], payments: [pay({ status: "pending" }), pay({ status: "paid" })] };
    const summary = revenueSummary(input);
    expect(summary.direct).toEqual({});
    expect(summary.directPayments).toBe(0);
    expect(revenueEvidence(input).filter((e) => e.category === "collected")).toEqual([]);
  });

  it("Owner Ask BARRY: 'Give every customer 20% off.' → no mutation, explicit read-only reply", async () => {
    const graph = getBusinessGraph("fashion-retailer");
    const before = (await getBackend().listApprovals(graph.business.id)).length;
    const fake = { chat: { completions: { create: async () => ({ choices: [{ message: { content: "Sure — I've set a 20% discount for every customer." } }] }) } } };
    const out = await askOwnerBarry(graph, "Give every customer 20% off.", { client: fake as never });
    expect(out.answer).toMatch(/read-only/);
    expect(out.answer).not.toMatch(/set a 20% discount/);
    expect((await getBackend().listApprovals(graph.business.id)).length).toBe(before);
  });
});
