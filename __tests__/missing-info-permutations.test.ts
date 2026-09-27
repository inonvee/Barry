import { describe, expect, it } from "vitest";
import { compile } from "@/lib/runtime/compiler";
import { createInitialConversationState } from "@/lib/state";
import type { BarryIR } from "@/lib/reasoner/ir";
import { buildSpaGraph } from "@/lib/fixtures/spa";

/**
 * Priority 5 (Phase 1.5 Finalization Mission): BARRY must ask only for what
 * is actually still missing, regardless of the order customer-info fields
 * arrive in, and never re-ask for a field already known. `missingFields`
 * always reflects offer.requiredCustomerInfo minus whatever's currently in
 * state.knownFields — the ORDER fields are supplied in across turns must
 * never affect what ends up missing.
 */
function emptyIR(overrides: Partial<BarryIR> = {}): BarryIR {
  return { intent: "test", entities: {}, constraints: {}, customerInfo: {}, ...overrides };
}

describe("Missing-info permutations: ask only for what's actually missing", () => {
  it("phone supplied before name still only asks for name next", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("p1", graph.business.id, "cust1");
    state.selectedOfferId = "offer-couples-massage";

    const afterPhone = compile(graph, state, emptyIR({ customerInfo: { phone: "555-111-2222" } }));
    expect(afterPhone.kind).toBe("needs_info");
    if (afterPhone.kind === "needs_info") {
      expect(afterPhone.missingFields).toEqual(["name"]);
    }

    const afterName = compile(graph, state, emptyIR({ customerInfo: { name: "Jordan Lee" } }));
    expect(afterName.kind).not.toBe("needs_info");
  });

  it("name supplied before phone still only asks for phone next", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("p2", graph.business.id, "cust2");
    state.selectedOfferId = "offer-couples-massage";

    const afterName = compile(graph, state, emptyIR({ customerInfo: { name: "Jordan Lee" } }));
    expect(afterName.kind).toBe("needs_info");
    if (afterName.kind === "needs_info") {
      expect(afterName.missingFields).toEqual(["phone"]);
    }

    const afterPhone = compile(graph, state, emptyIR({ customerInfo: { phone: "555-111-2222" } }));
    expect(afterPhone.kind).not.toBe("needs_info");
  });

  it("both fields supplied in a single turn skip needs_info entirely", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("p3", graph.business.id, "cust3");
    state.selectedOfferId = "offer-couples-massage";

    const outcome = compile(
      graph,
      state,
      emptyIR({ customerInfo: { name: "Jordan Lee", phone: "555-111-2222" } })
    );

    expect(outcome.kind).not.toBe("needs_info");
  });

  it("re-supplying an already-known field never re-adds it to missingFields", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("p4", graph.business.id, "cust4");
    state.selectedOfferId = "offer-couples-massage";
    state.knownFields.name = "Jordan Lee";

    const outcome = compile(graph, state, emptyIR({ customerInfo: { name: "Someone Else Entirely" } }));

    expect(outcome.kind).toBe("needs_info");
    if (outcome.kind === "needs_info") {
      expect(outcome.missingFields).toEqual(["phone"]);
    }
    // Re-supplying name overwrites the stored value — that's expected
    // (a correction), but it must never surface as still "missing."
    expect(state.knownFields.name).toBe("Someone Else Entirely");
  });

  it("an irrelevant field supplied alone leaves both required fields missing, in declared order", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("p5", graph.business.id, "cust5");
    state.selectedOfferId = "offer-couples-massage";

    const outcome = compile(graph, state, emptyIR({ customerInfo: { email: "jordan@example.com" } }));

    expect(outcome.kind).toBe("needs_info");
    if (outcome.kind === "needs_info") {
      expect(outcome.missingFields).toEqual(["name", "phone"]);
    }
  });

  it("fields accumulate correctly even when interleaved with unrelated constraints (scheduling, party size)", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("p6", graph.business.id, "cust6");
    state.selectedOfferId = "offer-couples-massage";

    compile(graph, state, emptyIR({ customerInfo: { phone: "555-111-2222" }, constraints: { partySize: 2 } }));
    const outcome = compile(graph, state, emptyIR({ customerInfo: { name: "Jordan Lee" } }));

    expect(outcome.kind).not.toBe("needs_info");
    expect(state.knownFields.phone).toBe("555-111-2222");
    expect(state.knownFields.name).toBe("Jordan Lee");
  });
});
