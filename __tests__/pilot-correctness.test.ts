import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { buildLogisticsDemoGraph, demoHelpdeskTickets, resetDemoHelpdeskForTests } from "@/lib/fixtures/logistics-demo";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { revalidateUnresolvedTurns } from "@/lib/runtime/engine";
import { readLedger } from "@/lib/runtime/ledger";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { getConversationStore } from "@/lib/state";
import { composeSummaryFor } from "@/lib/reasoner/openai-reasoner";
import { setReasonerForTests, type BarryIR, type ReasonerContext } from "@/lib/reasoner";
import { ScriptedModel, approvalsOf, conv, isolatedRetailer, ticket, type Plan } from "./support/scripted-model";

/**
 * Paid-pilot correctness (Phase 1): a consequential approval never executes on terms the customer may
 * have changed in a message BARRY couldn't understand — and once that message CAN be understood, what
 * it said is applied (or the hold released), generically. Multi-ask messages are completed or told
 * as partial; business facts carry provenance.
 */

let dispose: (() => void) | undefined;
afterEach(() => {
  setReasonerForTests(undefined);
  resetDemoHelpdeskForTests();
  dispose?.();
  dispose = undefined;
});

describe("stale approval: correction + understanding failure, then revalidation", () => {
  const C301 = "Different parcel Q4-C301 now, delayed. Create one owner approval for a delay case only.";
  const CORRECTION = "Wait C302, not301. Correct reference and change reason to damaged instead of delayed; replace the pending one now.";

  function scenario(providerUp: () => boolean, onCorrection: Plan) {
    const g = buildLogisticsDemoGraph();
    const model = new ScriptedModel((ctx: ReasonerContext) => {
      if (ctx.customerMessage === C301) return ticket("Q4-C301");
      if (ctx.customerMessage === CORRECTION) return providerUp() ? onCorrection : "FAIL";
      return providerUp() ? { advancesTransaction: false } : "FAIL";
    });
    setReasonerForTests(model);
    return { g, id: conv("reval"), model };
  }

  it("provider still down at approve time: held, nothing executes, request stays pending", async () => {
    const { g, id } = scenario(() => false, undefined);
    await handleCustomerMessage(g, id, "c", C301);
    const [pending] = await approvalsOf(g, id);
    await handleCustomerMessage(g, id, "c", CORRECTION);
    const out = await resumeAfterApproval(g, pending.id, "approved", "owner");
    expect(demoHelpdeskTickets()).toHaveLength(0);
    expect(out.turn.trace?.stop.reason).toBe("approval_held_customer_intent_unverified");
    expect((await approvalsOf(g, id))[0].status).toBe("pending");
  });

  it("provider back at approve time and the correction changed the request: the stale request is superseded, never executed, and the customer is told", async () => {
    let up = false;
    const { g, id } = scenario(() => up, { changesPendingRequest: true, advancesTransaction: true });
    await handleCustomerMessage(g, id, "c", C301);
    const [pending] = await approvalsOf(g, id);
    await handleCustomerMessage(g, id, "c", CORRECTION);
    up = true;
    const out = await resumeAfterApproval(g, pending.id, "approved", "owner");
    expect(demoHelpdeskTickets()).toHaveLength(0);
    const [after] = await approvalsOf(g, id);
    expect(after.status).toBe("declined");
    expect(after.resolution?.decidedBy).toBe("customer:changed_terms");
    const state = (await getConversationStore().get(id))!;
    expect(readLedger(state).map((e) => e.effect)).toEqual(expect.arrayContaining(["understanding.failed", "request.superseded", "understanding.revalidated"]));
    expect(state.messages.at(-1)?.content).toMatch(/earlier request was cancelled/);
    expect(out.response).toMatch(/already/);
  });

  it("provider back and the unreadable message was unrelated: the hold is released by evidence and the request executes exactly once", async () => {
    let up = false;
    const g = buildLogisticsDemoGraph();
    const model = new ScriptedModel((ctx) => (ctx.customerMessage === C301 ? ticket("Q4-C301") : up ? { advancesTransaction: false, readRequested: false } : "FAIL"));
    setReasonerForTests(model);
    const id = conv("unrelated");
    await handleCustomerMessage(g, id, "c", C301);
    const [pending] = await approvalsOf(g, id);
    await handleCustomerMessage(g, id, "c", "How long does normal delivery take?");
    const before = (await getConversationStore().get(id))!;
    expect(withLifecycle(await approvalsOf(g, id), new Map([[id, before]]))[0].lifecycle).toBe("held");
    up = true;
    await resumeAfterApproval(g, pending.id, "approved", "owner");
    expect(demoHelpdeskTickets()).toHaveLength(1);
    expect(demoHelpdeskTickets()[0].reference).toBe("Q4-C301");
  });

  it("revalidation also runs at the start of the next customer turn: the stale request is gone before anything else happens", async () => {
    let up = false;
    const { g, id } = scenario(() => up, { withdrawsRequest: true, advancesTransaction: false });
    await handleCustomerMessage(g, id, "c", C301);
    await handleCustomerMessage(g, id, "c", CORRECTION);
    up = true;
    const out = await handleCustomerMessage(g, id, "c", "hello? did you get that?");
    expect((await approvalsOf(g, id)).filter((a) => a.status === "pending")).toHaveLength(0);
    expect(out.turn.trace?.revalidation).toMatchObject({ revalidated: 1, changedRequests: 1 });
  });

  it("an owner re-check with the provider still down changes nothing", async () => {
    const { g, id } = scenario(() => false, undefined);
    await handleCustomerMessage(g, id, "c", C301);
    await handleCustomerMessage(g, id, "c", CORRECTION);
    const state = (await getConversationStore().get(id))!;
    expect(await revalidateUnresolvedTurns(g, state)).toMatchObject({ revalidated: 0, stillUnresolved: 1 });
    expect((await approvalsOf(g, id))[0].status).toBe("pending");
  });
});

describe("multi-intent completeness", () => {
  async function retailerWithResults() {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const model = new ScriptedModel(() => ({ commerce: { intent: "search", query: { category: "dress" } }, advancesTransaction: true }));
    setReasonerForTests(model);
    const id = conv("multi");
    const search = await handleCustomerMessage(r.g, id, "c", "שמלות שחורות");
    const titles = search.rich?.products?.map((p) => p.title) ?? [];
    return { ...r, model, id, pos: (t: string) => titles.indexOf(t) };
  }
  const add = (index: number): Partial<BarryIR> => ({ commerce: { intent: "select", reference: { type: "previous_result", index }, variant: { size: "M" }, quantity: 1 }, purchaseDecision: false, checkoutConsent: false, advancesTransaction: true });
  const TWO = "הראשונה Midnight שחור M אחת לסל, ואז Onyx שחור M אחת גם. שתי שורות נפרדות. בלי קופה";
  const asks = [
    { ask: "Midnight שחור M אחת לסל", kind: "change" as const, coveredByThisIR: true },
    { ask: "Onyx שחור M אחת", kind: "change" as const, coveredByThisIR: false },
  ];

  it("two adds in one message: the second ask is continued (grounded, compiled, executed) — both lines in the provider cart", async () => {
    const { g, commerce, model, id, pos } = await retailerWithResults();
    model.plan = (ctx) => (ctx.grounded?.remainingAsks?.length ? { ...add(pos("Onyx Slip Dress")), asks: [{ ask: "Onyx", kind: "change", coveredByThisIR: true }] } : { ...add(pos("Midnight Wrap Dress")), asks });
    const out = await handleCustomerMessage(g, id, "c", TWO);
    const cart = (await commerce.getCart(out.state.knownFields.__commerceCartId))!;
    expect(cart.lines.map((l) => l.title).sort()).toEqual(["Midnight Wrap Dress", "Onyx Slip Dress"]);
    expect(out.turn.trace?.steps.map((s) => s.trigger)).toEqual(["customer", "customer"]);
    expect(out.response).not.toMatch(/עוד לא טיפלתי/);
  });

  it("when the second ask can't be carried out, the reply says it was NOT done (never silently dropped)", async () => {
    const { g, commerce, model, id, pos } = await retailerWithResults();
    model.plan = (ctx) => (ctx.grounded?.remainingAsks?.length ? { advancesTransaction: false } : { ...add(pos("Midnight Wrap Dress")), asks });
    const out = await handleCustomerMessage(g, id, "c", TWO);
    const cart = (await commerce.getCart(out.state.knownFields.__commerceCartId))!;
    expect(cart.lines.map((l) => l.title)).toEqual(["Midnight Wrap Dress"]);
    expect(out.response).toMatch(/עוד לא טיפלתי ב: Onyx שחור M אחת/);
  });

  it("a mutation plus a policy question: the question is not listed as 'not done' (it is answered from facts, not executed)", async () => {
    const { g, model, id, pos } = await retailerWithResults();
    model.plan = () => ({ ...add(pos("Midnight Wrap Dress")), asks: [asks[0], { ask: "אפשר להחזיר פריטי סייל?", kind: "question", coveredByThisIR: false }] });
    const out = await handleCustomerMessage(g, id, "c", "Midnight M לסל. ופריטי סייל אפשר להחזיר?");
    expect(out.response).not.toMatch(/עוד לא טיפלתי/);
    expect(out.turn.trace?.steps).toHaveLength(1);
  });

  it("the continuation can't withdraw or revise anything on its own, and never repeats a step", async () => {
    const { g, commerce, model, id, pos } = await retailerWithResults();
    model.plan = (ctx) => (ctx.grounded?.remainingAsks?.length ? { ...add(pos("Midnight Wrap Dress")), withdrawsRequest: true } : { ...add(pos("Midnight Wrap Dress")), asks });
    const out = await handleCustomerMessage(g, id, "c", TWO);
    const cart = (await commerce.getCart(out.state.knownFields.__commerceCartId))!;
    expect(cart.lines).toHaveLength(1);
    expect(out.turn.trace?.steps).toHaveLength(1);
  });
});

describe("business-fact provenance reaches the composer", () => {
  it("facts are labelled by source; hours a business never gave are 'not_provided'", () => {
    const { g, dispose: d } = isolatedRetailer();
    dispose = d;
    const state = { id: "x", businessId: g.business.id, customerId: "c", stage: "discovery" as const, knownFields: {}, missingFields: [], objections: [], pendingAction: null, pendingApprovalId: null, outcome: "pending" as const, messages: [], turns: [], createdAt: "", updatedAt: "" };
    const summary = composeSummaryFor({ graph: g, state, customerMessage: "open friday?" }, { outcome: { kind: "conversation", stage: "discovery" } }) as { facts: { provenance: Record<string, string> } };
    expect(summary.facts.provenance).toMatchObject({ offers: "business_genome", openingHours: "not_provided", shownProducts: "provider_read_this_turn" });
  });
});
