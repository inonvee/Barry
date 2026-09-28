import { afterEach, describe, expect, it } from "vitest";
import { handleCustomerMessage, handlePaymentWebhook } from "@/lib/runtime";
import { MAX_STEPS_PER_TURN } from "@/lib/runtime/engine";
import { buildFashionRetailerGraph, fashionCatalog } from "@/lib/fixtures/fashion-retailer";
import { buildEcommerceBagsGraph } from "@/lib/fixtures/ecommerce-bags";
import { setReasonerForTests, type BarryIR } from "@/lib/reasoner";
import { buildUnderstandingContext } from "@/lib/reasoner/openai-reasoner";
import { CONSTITUTION_VERSION } from "@/lib/reasoner/constitution";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { MemoryPaymentAdapter, signedMemoryWebhook } from "@/lib/payments/adapters/memory";
import { registerCommerceAdapterFactoryForTests, resolveCommerceAdapterForBusiness } from "@/lib/commerce/registry";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { resolveCapabilityProfiles } from "@/lib/capabilities";
import { getBackend } from "@/lib/store";
import type { BusinessGraph } from "@/lib/business-graph";
import { ScriptedReasoner } from "./support/semantic-corpus";

/**
 * BARRY is goal-driven, not request-driven. Live gap this closes: after
 * "אני אקח את הראשונה ב-M" BARRY correctly added Onyx M to a real cart and
 * then stopped with "tell me if you want to continue to checkout". A
 * customer who has decided should not have to operate BARRY.
 */

const SEARCH = "עד 400 שקל M אני מחפשת שמלה מידה";
const TAKE = "אני אקח את הראשונה ב-M";
const DETAILS = "דנה, 0501234567";

const SCRIPT: Record<string, Partial<BarryIR>> = {
  [SEARCH]: {
    intent: "commerce_search",
    commerce: { intent: "search", query: { text: SEARCH, category: "dress", attributes: { color: "black" }, budget: { amount: 400 } }, variant: { size: "M" } },
  },
  [TAKE]: {
    intent: "commerce_select",
    purchaseDecision: true,
    commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } },
  },
  "add the first one in M, and show me belts too": {
    intent: "commerce_select",
    purchaseDecision: false,
    commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } },
  },
  [DETAILS]: {
    intent: "provide_details",
    customerInfo: { name: "דנה", phone: "0501234567" },
    evidence: { "customerInfo.name": "דנה", "customerInfo.phone": "0501234567" },
  },
  "checkout": { intent: "commerce_checkout", commerce: { intent: "checkout" } },
  // Two results: 0 = Midnight Wrap Dress (S sold out), 1 = Onyx Slip Dress (M only in stock).
  "show me black dresses": { intent: "commerce_search", commerce: { intent: "search", query: { text: "black dresses", category: "dress", attributes: { color: "black" } } } },
  "add the second one in M": {
    intent: "commerce_select",
    purchaseDecision: false,
    commerce: { intent: "select", reference: { type: "previous_result", index: 1 }, variant: { size: "M" } },
  },
  "I'll take the second one in M": {
    intent: "commerce_select",
    purchaseDecision: true,
    commerce: { intent: "select", reference: { type: "previous_result", index: 1 }, variant: { size: "M" } },
  },
  "actually swap it for the first one in S, I'll take that": {
    intent: "commerce_replace",
    purchaseDecision: true,
    commerce: { intent: "replace", reference: { type: "previous_result", index: 0 }, variant: { size: "S" } },
  },
  "make it L, I'll take it": {
    intent: "commerce_change_variant",
    purchaseDecision: true,
    commerce: { intent: "change_variant", reference: { type: "cart_line", index: 0 }, variant: { size: "L" } },
  },
  "I paid": { intent: "payment_claim", customerClaims: { paymentCompleted: true } },
};

function withPlaybook(graph: BusinessGraph, commerce: Partial<BusinessGraph["playbook"]["commerce"]>, id?: string): BusinessGraph {
  return {
    ...graph,
    business: { ...graph.business, id: id ?? graph.business.id },
    playbook: { ...graph.playbook, commerce: { ...graph.playbook.commerce, ...commerce } },
  };
}

let n = 0;
const registered: string[] = [];

/**
 * Runs a conversation against its OWN fresh catalog (a unique business id
 * with its own memory provider), so stock consumed by one test's order
 * never leaks into another. Snapshots each turn's state, since the memory
 * store hands back the same live object across turns.
 */
async function converse(graph: BusinessGraph, messages: string[], options: { freshCatalog?: boolean } = { freshCatalog: true }) {
  setReasonerForTests(new ScriptedReasoner(SCRIPT));
  const payments = new MemoryPaymentAdapter();
  setPaymentAdapterForTests(payments);
  let g = graph;
  if (options.freshCatalog) {
    const id = `${graph.business.id}-op-${n}`;
    const adapter = new MemoryCommerceAdapter(fashionCatalog());
    registerCommerceAdapterFactoryForTests(id, () => adapter);
    registered.push(id);
    g = { ...graph, business: { ...graph.business, id } };
  }
  const conv = `op-${Date.now()}-${n++}`;
  const outs = [];
  for (const m of messages) {
    const out = await handleCustomerMessage(g, conv, `c-${conv}`, m);
    outs.push({ ...out, state: structuredClone(out.state) });
  }
  return { conv, outs, last: outs[outs.length - 1], payments, graph: g };
}

afterEach(() => {
  setReasonerForTests(undefined);
  setPaymentAdapterForTests(undefined);
  for (const id of registered.splice(0)) registerCommerceAdapterFactoryForTests(id, undefined);
});

describe("a decided customer is carried to checkout", () => {
  it("the live gap: 'I'll take the first in M' adds Onyx M AND sends the checkout link in the same turn", async () => {
    const graph = withPlaybook(buildFashionRetailerGraph(), { checkoutRequires: [] });
    const { last } = await converse(graph, [SEARCH, TAKE]);

    expect(last.turn.trace?.steps.map((s) => [s.action, s.trigger, s.result?.ok])).toEqual([
      ["addToCart", "customer", true],
      ["createCommerceCheckout", "continuation", true],
    ]);
    expect(last.state.stage).toBe("payment");
    expect(last.rich?.paymentUrl).toMatch(/^https:\/\//);
    const payment = (await getBackend().getPaymentRequest(last.state.knownFields.__paymentRequestId))!;
    expect(payment).toMatchObject({ amount: 390, currency: "ILS", status: "pending" });
    expect(last.response).toMatch(/Onyx Slip Dress/);
    expect(last.response).not.toMatch(/if you want to (continue|check ?out)|would you like|shall i continue|let me know/i);
  });

  it("with the business's checkout requirements, BARRY asks only for those — then checks out on the answer", async () => {
    const { outs, last } = await converse(buildFashionRetailerGraph(), [SEARCH, TAKE, DETAILS]);
    const take = outs[1];
    expect(take.turn.trace?.steps.map((s) => s.action)).toEqual(["addToCart"]);
    expect(take.turn.trace?.stop).toEqual({ reason: "needs_customer", outcome: "checkout_needs_info" });
    expect(take.state.missingFields).toEqual(["name", "phone"]);
    // Hebrew conversation -> Hebrew request, for exactly the business's fields.
    expect(take.response).toMatch(/שם/);
    expect(take.response).toMatch(/טלפון/);

    expect(last.turn.trace?.steps.map((s) => [s.action, s.trigger])).toEqual([["createCommerceCheckout", "customer"]]);
    expect(last.rich?.paymentUrl).toBeTruthy();
  });

  it("verified payment continues to the order; nothing is claimed before the provider confirms", async () => {
    const graph = withPlaybook(buildFashionRetailerGraph(), { checkoutRequires: [] });
    const { conv, last, payments, graph: g } = await converse(graph, [SEARCH, TAKE]);
    const payment = (await getBackend().getPaymentRequest(last.state.knownFields.__paymentRequestId))!;

    const claim = await handleCustomerMessage(g, conv, `c-${conv}`, "I paid");
    expect(claim.turn.trace?.steps.map((s) => s.action)).toEqual(["verifyPayment"]);
    expect(claim.state.outcome).not.toBe("won");

    payments.payments.get(payment.providerPaymentId!)!.status = "paid";
    const confirmed = await handleCustomerMessage(g, conv, `c-${conv}`, "I paid");
    expect(confirmed.turn.trace?.steps.map((s) => [s.action, s.trigger])).toEqual([
      ["verifyPayment", "customer"],
      ["createCommerceOrder", "continuation"],
    ]);
    expect(confirmed.state.outcome).toBe("won");

    const webhook = signedMemoryWebhook({ eventId: `evt-${conv}`, providerPaymentId: payment.providerPaymentId!, conversationId: conv, status: "paid" });
    await handlePaymentWebhook(webhook.body, webhook.headers).catch(() => undefined);
    expect((await getBackend().listCommerceOrders(g.business.id)).filter((o) => o.conversationId === conv)).toHaveLength(1);
  });
});

describe("the customer and the business stay in control", () => {
  it("a customer still browsing gets the item added, not a checkout", async () => {
    const graph = withPlaybook(buildFashionRetailerGraph(), { checkoutRequires: [] });
    const { last } = await converse(graph, [SEARCH, "add the first one in M, and show me belts too"]);
    expect(last.turn.trace?.steps.map((s) => s.action)).toEqual(["addToCart"]);
    expect(last.state.knownFields.__paymentRequestId).toBeUndefined();
  });

  it("a business whose playbook says 'on request' keeps the cart open until the customer asks", async () => {
    const graph = withPlaybook(buildFashionRetailerGraph(), { checkoutRequires: [], advanceToCheckout: "on_request" });
    const { outs } = await converse(graph, [SEARCH, TAKE, "checkout"]);
    expect(outs[1].turn.trace?.steps.map((s) => s.action)).toEqual(["addToCart"]);
    expect(outs[2].turn.trace?.steps.map((s) => s.action)).toEqual(["createCommerceCheckout"]);
  });

  it("a checkout above the business's automatic payment limit goes to the owner, not to the customer", async () => {
    const base = withPlaybook(buildFashionRetailerGraph(), { checkoutRequires: [] });
    const graph: BusinessGraph = {
      ...base,
      policies: base.policies.map((p) => (p.rule.type === "max_auto_payment_amount" ? { ...p, rule: { type: "max_auto_payment_amount" as const, value: 300 } } : p)),
    };
    const { last } = await converse(graph, [SEARCH, TAKE]);
    const [add, checkout] = last.turn.trace!.steps;
    expect(add.action).toBe("addToCart");
    expect(checkout).toMatchObject({ action: "createCommerceCheckout", trigger: "continuation", policy: { status: "requires_approval", policyId: "max_auto_payment_amount" }, result: null });
    expect(last.turn.trace?.stop.reason).toBe("owner_approval_required");
    expect(last.state.pendingApprovalId).toBeTruthy();
    expect(last.state.knownFields.__paymentRequestId).toBeUndefined();
    expect(last.rich?.paymentUrl).toBeUndefined();
  });

  it("a provider that can't check out is never asked to — BARRY says so instead of failing", async () => {
    class CatalogOnly extends MemoryCommerceAdapter {
      async describeCapabilities() {
        return ["catalogSearch", "catalogSchema", "variants", "liveInventory", "cart"];
      }
    }
    const id = `catalog-only-${Date.now()}`;
    const adapter = new CatalogOnly(fashionCatalog());
    registerCommerceAdapterFactoryForTests(id, () => adapter);
    try {
      const graph = withPlaybook(buildFashionRetailerGraph(), { checkoutRequires: [] }, id);
      const profiles = await resolveCapabilityProfiles(graph);
      expect(profiles.commerce.missingOperations).toEqual(expect.arrayContaining(["checkout", "orders"]));
      const { last } = await converse(graph, [SEARCH, TAKE], { freshCatalog: false });
      expect(last.turn.trace?.steps.map((s) => s.action)).toEqual(["addToCart"]);
      expect(last.turn.trace?.stop).toEqual({ reason: "needs_customer", outcome: "capability_unavailable" });
      expect(last.response).toMatch(/follow up|יחזור אלייך/i);
    } finally {
      registerCommerceAdapterFactoryForTests(id, undefined);
    }
  });

  it("interest is not a decision: an availability question never triggers a payment link", async () => {
    setReasonerForTests(undefined); // offline stand-in
    setPaymentAdapterForTests(new MemoryPaymentAdapter());
    const graph = buildEcommerceBagsGraph();
    const conv = `op-bags-${Date.now()}`;
    await handleCustomerMessage(graph, conv, "c", "Do you have the Commuter Backpack?");
    const stock = await handleCustomerMessage(graph, conv, "c", "shopper@example.com");
    expect(stock.turn.trace?.steps.map((s) => s.action)).toEqual(["checkInventory"]);
    expect(stock.turn.trace?.stop.outcome).toBe("confirm_purchase");
    expect(stock.state.knownFields.__paymentRequestId).toBeUndefined();
    expect(stock.response).toMatch(/payment link/i);

    const yes = await handleCustomerMessage(graph, conv, "c", "yes please");
    expect(yes.turn.trace?.steps.map((s) => s.action)).toEqual(["createPaymentRequest"]);
  });

  it("the loop is bounded: never more than the step budget, never the same action twice in one turn", async () => {
    const graph = withPlaybook(buildFashionRetailerGraph(), { checkoutRequires: [] });
    const { outs } = await converse(graph, [SEARCH, TAKE]);
    for (const out of outs) {
      const actions = out.turn.trace?.steps.map((s) => s.action) ?? [];
      expect(actions.length).toBeLessThanOrEqual(MAX_STEPS_PER_TURN);
      expect(new Set(actions).size).toBe(actions.length);
    }
  });
});

describe("checkout eligibility follows VERIFIED cart state, never the customer's words alone", () => {
  const ONYX = "prod-onyx-slip-dress";

  async function cartOf(graph: BusinessGraph, cartId: string | undefined) {
    const adapter = await resolveCommerceAdapterForBusiness(graph.business.id);
    return cartId ? adapter.getCart(cartId) : undefined;
  }

  it("deciding to swap the cart item for an UNAVAILABLE one never checks out the old cart", async () => {
    const graph = withPlaybook(buildFashionRetailerGraph(), { checkoutRequires: [] });
    const { outs, graph: g } = await converse(graph, ["show me black dresses", "add the second one in M", "actually swap it for the first one in S, I'll take that"]);
    const [, added, swap] = outs;
    expect(added.turn.trace?.steps.map((st) => st.action)).toEqual(["addToCart"]);

    // The swap call ran, but the requested change did not happen.
    expect(swap.turn.trace?.steps.map((st) => [st.action, st.result?.ok])).toEqual([["addToCart", true]]);
    expect(swap.turn.toolResult?.output).toMatchObject({ added: false, notAdded: { reason: "unavailable" } });
    expect(swap.turn.trace?.stop).toEqual({ reason: "requested_change_not_applied", outcome: "addToCart" });

    // Old item A remains; no checkout, no payment link.
    const cart = await cartOf(g, swap.state.knownFields.__commerceCartId);
    expect(cart?.lines.map((l) => [l.productId, l.options.size])).toEqual([[ONYX, "M"]]);
    expect(swap.state.knownFields.__paymentRequestId).toBeUndefined();
    expect(swap.state.knownFields.__commerceCheckoutRequested).toBeUndefined();
    expect(swap.rich?.paymentUrl).toBeUndefined();
    const payments = (await getBackend().listPaymentRequests(g.business.id)).filter((p) => p.conversationId === swap.state.id);
    expect(payments).toHaveLength(0);

    // BARRY explains and asks for another choice.
    expect(swap.response).toMatch(/isn't available in S/i);
    expect(swap.response).toMatch(/M|L/);
  });

  it("a failed swap also cancels an EARLIER decision: supplying details afterwards does not check out the stale cart", async () => {
    // Rina Studio's real playbook: name + phone before checkout.
    const { outs, last } = await converse(buildFashionRetailerGraph(), [
      "show me black dresses",
      "I'll take the second one in M", // decided; waiting on details
      "actually swap it for the first one in S, I'll take that", // fails: S sold out
      DETAILS,
    ]);
    expect(outs[1].turn.trace?.stop.outcome).toBe("checkout_needs_info");
    expect(outs[2].turn.trace?.stop.reason).toBe("requested_change_not_applied");
    expect(last.turn.trace?.steps.map((st) => st.action) ?? []).not.toContain("createCommerceCheckout");
    expect(last.state.knownFields.__paymentRequestId).toBeUndefined();
  });

  it("a failed variant change with a purchase decision never checks out the unchanged cart", async () => {
    const graph = withPlaybook(buildFashionRetailerGraph(), { checkoutRequires: [] });
    const { outs, graph: g } = await converse(graph, ["show me black dresses", "add the second one in M", "make it L, I'll take it"]);
    const change = outs[2];
    expect(change.turn.trace?.steps.map((st) => st.action)).toEqual(["updateCartLine"]);
    expect(change.turn.toolResult?.output).toMatchObject({ added: false });
    expect(change.turn.trace?.stop.reason).toBe("requested_change_not_applied");
    const cart = await cartOf(g, change.state.knownFields.__commerceCartId);
    expect(cart?.lines.map((l) => [l.productId, l.options.size])).toEqual([[ONYX, "M"]]);
    expect(change.state.knownFields.__paymentRequestId).toBeUndefined();
    expect(change.rich?.paymentUrl).toBeUndefined();
  });

  it("a SUCCESSFUL change with a purchase decision does proceed to checkout (the intent is kept, not lost)", async () => {
    const graph = withPlaybook(buildFashionRetailerGraph(), { checkoutRequires: [] });
    const { last } = await converse(graph, ["show me black dresses", "I'll take the second one in M"]);
    expect(last.turn.trace?.steps.map((st) => st.action)).toEqual(["addToCart", "createCommerceCheckout"]);
    expect(last.state.knownFields.__commerceCheckoutOnSuccess).toBeUndefined();
  });
});

describe("capability gate applies to customer-triggered actions too", () => {
  it("a provider without carts is never asked to add to cart — BARRY hands off instead", async () => {
    class NoCart extends MemoryCommerceAdapter {
      async describeCapabilities() {
        return ["catalogSearch", "catalogSchema", "variants", "liveInventory"];
      }
    }
    const id = `no-cart-${Date.now()}`;
    let addCalls = 0;
    const adapter = new NoCart(fashionCatalog());
    const original = adapter.addToCart.bind(adapter);
    adapter.addToCart = async (input) => {
      addCalls += 1;
      return original(input);
    };
    registerCommerceAdapterFactoryForTests(id, () => adapter);
    try {
      const graph = withPlaybook(buildFashionRetailerGraph(), { checkoutRequires: [] }, id);
      const { outs } = await converse(graph, ["show me black dresses", "add the second one in M"], { freshCatalog: false });
      expect(outs[0].turn.trace?.steps.map((st) => st.action)).toEqual(["searchProducts"]);
      const take = outs[1];
      expect(take.turn.trace?.steps).toEqual([]);
      expect(take.turn.trace?.stop).toEqual({ reason: "capability_unavailable", outcome: "addToCart" });
      expect(take.turn.selectedAction ?? undefined).toBeUndefined();
      expect(take.state.knownFields.__commerceCartId).toBeUndefined();
      expect(addCalls).toBe(0);
      expect(take.response).toMatch(/follow up|יחזור אלייך/i);
    } finally {
      registerCommerceAdapterFactoryForTests(id, undefined);
    }
  });
});

describe("every turn explains itself (HQ-ready)", () => {
  it("records runtime versions, capability + provider per step, policy, result, and only the NAMES of changed state", async () => {
    const graph = withPlaybook(buildFashionRetailerGraph(), { checkoutRequires: [] });
    const { last } = await converse(graph, [SEARCH, TAKE]);
    const trace = last.turn.trace!;
    expect(trace.runtime).toMatchObject({ barryVersion: expect.any(String), constitutionVersion: CONSTITUTION_VERSION, reasoner: "llm" });
    expect(trace.steps[1]).toMatchObject({
      action: "createCommerceCheckout",
      capabilities: [
        { capability: "commerce", provider: "memory" },
        { capability: "payments", provider: "memory" },
      ],
      policy: { status: "allowed" },
      result: { ok: true },
      stageAfter: "payment",
    });
    expect(trace.steps[1].stateKeysChanged).toEqual(expect.arrayContaining(["__paymentRequestId"]));
    expect(JSON.stringify(trace)).not.toMatch(/0501234567|https?:\/\//);
  });

  it("grounding rejections are part of the trace", async () => {
    setReasonerForTests(new ScriptedReasoner({ hello: { intent: "x", customerInfo: { name: "Ghost" } } }));
    const out = await handleCustomerMessage(buildFashionRetailerGraph(), `op-rej-${Date.now()}`, "c", "hello");
    expect(out.turn.trace?.rejectedClaims).toEqual([{ claim: "customerInfo.name", reason: expect.any(String) }]);
  });
});

describe("the model receives the business's working context, not raw graph data", () => {
  it("goals, playbook, authority, connected capabilities, catalog and transaction state", async () => {
    const { conv, graph } = await converse(buildFashionRetailerGraph(), [SEARCH]);
    const state = (await (await import("@/lib/state")).getConversationStore().get(conv))!;
    const profiles = await resolveCapabilityProfiles(graph);
    const adapter = await resolveCommerceAdapterForBusiness(graph.business.id);
    const context = buildUnderstandingContext({ graph, state, customerMessage: TAKE, grounded: { profiles, catalog: await adapter.describeCatalog() } });
    expect(context).toMatchObject({
      goals: ["completePurchase"],
      playbook: { advanceToCheckout: "on_purchase_decision", suggestions: "one_relevant", salesStyle: expect.stringMatching(/warm/i) },
      authority: { maxAutomaticDiscountPct: 5, maxAutomaticPaymentAmount: 2000 },
      transaction: { cartOpen: false, checkoutSent: false, paid: false, orderPlaced: false },
    });
    expect(context.connectedCapabilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: "commerce", connected: true, operations: expect.arrayContaining(["checkout"]) })])
    );
    expect(context.catalog?.currency).toBe("ILS");
    expect(JSON.stringify(context)).not.toMatch(/credentialsRef|apiKey|secret/i);
  });
});
