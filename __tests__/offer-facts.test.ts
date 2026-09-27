import { describe, expect, it } from "vitest";
import { compile } from "@/lib/runtime/compiler";
import { createInitialConversationState } from "@/lib/state";
import type { BarryIR } from "@/lib/reasoner/ir";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { buildGarageGraph } from "@/lib/fixtures/garage";

/**
 * Priority 4 (Phase 1.5 Finalization Mission): safe Business Graph facts —
 * price, duration, deposit — must be answerable BEFORE any
 * transaction-gate field (name/phone/...) is collected. requiredCustomerInfo
 * means "needed to FULFILL a booking," not "needed before BARRY may state a
 * fact that's already sitting in the Business Graph."
 */
function emptyIR(overrides: Partial<BarryIR> = {}): BarryIR {
  return { intent: "test", entities: {}, constraints: {}, customerInfo: {}, ...overrides };
}

describe("Offer facts answerable before transaction-gate fields", () => {
  it('"How much is the couples massage?" is answered without collecting name/phone first', () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("c1", graph.business.id, "cust1");
    // Deliberately no name/phone on file — offer-couples-massage requires both.

    const outcome = compile(
      graph,
      state,
      emptyIR({ selectedOfferId: "offer-couples-massage", requestedCapability: "ask_price" })
    );

    expect(outcome.kind).toBe("offer_fact");
    if (outcome.kind === "offer_fact") {
      expect(outcome.offerName).toBe("Couples Massage");
      expect(outcome.fact).toEqual({ type: "price", price: 220, currency: "USD" });
    }
  });

  it('"How long is it?" answers duration without requiring name/phone', () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("c2", graph.business.id, "cust2");

    const outcome = compile(
      graph,
      state,
      emptyIR({ selectedOfferId: "offer-couples-massage", requestedCapability: "ask_duration" })
    );

    expect(outcome.kind).toBe("offer_fact");
    if (outcome.kind === "offer_fact") {
      expect(outcome.fact).toEqual({ type: "duration", minutes: 60 });
    }
  });

  it('"Do you require a deposit?" answers deposit amount without requiring name/phone', () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("c3", graph.business.id, "cust3");

    const outcome = compile(
      graph,
      state,
      emptyIR({ selectedOfferId: "offer-couples-massage", requestedCapability: "ask_deposit" })
    );

    expect(outcome.kind).toBe("offer_fact");
    if (outcome.kind === "offer_fact") {
      expect(outcome.fact).toEqual({ type: "deposit", required: true, amount: 50, currency: "USD" });
    }
  });

  it("a fact question does NOT clear or bypass the missing-info gate for the NEXT (non-fact) turn", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("c4", graph.business.id, "cust4");

    const factOutcome = compile(
      graph,
      state,
      emptyIR({ selectedOfferId: "offer-couples-massage", requestedCapability: "ask_price" })
    );
    expect(factOutcome.kind).toBe("offer_fact");

    // Next turn: no fact question this time, and name/phone still unknown.
    const followUp = compile(graph, state, emptyIR());
    expect(followUp.kind).toBe("needs_info");
    if (followUp.kind === "needs_info") {
      expect(followUp.missingFields).toEqual(["name", "phone"]);
    }
  });

  it("an offer without a fixed price does not fabricate a price fact", () => {
    const graph = buildGarageGraph();
    const state = createInitialConversationState("c5", graph.business.id, "cust5");
    const quoteOnlyOffer = graph.offers.find((o) => o.price === null);
    expect(quoteOnlyOffer).toBeDefined();

    const outcome = compile(
      graph,
      state,
      emptyIR({ selectedOfferId: quoteOnlyOffer!.id, requestedCapability: "ask_price" })
    );

    // No price to report — falls through to normal flow instead of inventing one.
    expect(outcome.kind).not.toBe("offer_fact");
  });

  it("an unrecognized requestedCapability falls through to normal flow instead of hallucinating a fact", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("c6", graph.business.id, "cust6");

    const outcome = compile(
      graph,
      state,
      emptyIR({ selectedOfferId: "offer-couples-massage", requestedCapability: "ask_something_unrecognized" })
    );

    expect(outcome.kind).toBe("needs_info");
  });
});
