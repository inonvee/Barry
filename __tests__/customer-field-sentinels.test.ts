import { describe, expect, it } from "vitest";
import { normalizeCustomerFieldValue } from "@/lib/reasoner/customer-fields";
import { compile } from "@/lib/runtime/compiler";
import { createInitialConversationState } from "@/lib/state";
import type { BarryIR } from "@/lib/reasoner/ir";
import { buildSpaGraph } from "@/lib/fixtures/spa";

/**
 * Live Bug 3 (LIVE Phase 1.5 Bug Fix Mission): a persisted conversation row
 * had known_fields = { name: "null", phone: "null" } even though the SAME
 * turn's `understood.entities` correctly held { name: "Inon",
 * phone: "0558832177" }. A strict-JSON-schema Reasoner sometimes has to
 * supply *some* string for a customerInfo pair even when it means
 * "nothing new here" — the schema can't express omission — and can
 * literalize a sentinel like "null" instead. This is the ONE place that
 * class of value is rejected before it ever reaches persistent state,
 * regardless of which reasoner (or which field name) produced it.
 */
function emptyIR(overrides: Partial<BarryIR> = {}): BarryIR {
  return { intent: "test", entities: {}, constraints: {}, customerInfo: {}, ...overrides };
}

describe("normalizeCustomerFieldValue", () => {
  it("passes through a real value unchanged", () => {
    expect(normalizeCustomerFieldValue("Inon")).toBe("Inon");
    expect(normalizeCustomerFieldValue("0558832177")).toBe("0558832177");
  });

  it("rejects common sentinel strings, case-insensitively", () => {
    for (const sentinel of ["null", "NULL", "Null", "undefined", "none", "N/A", "n/a", "nil", "unknown"]) {
      expect(normalizeCustomerFieldValue(sentinel)).toBeUndefined();
    }
  });

  it("rejects empty and whitespace-only values", () => {
    expect(normalizeCustomerFieldValue("")).toBeUndefined();
    expect(normalizeCustomerFieldValue("   ")).toBeUndefined();
  });

  it("does not reject a real value that merely contains a sentinel word as a substring", () => {
    // A real name/business could legitimately contain these letters.
    expect(normalizeCustomerFieldValue("Nullah Ahmed")).toBe("Nullah Ahmed");
  });
});

describe("compiler-level: sentinel values never persist, real values always do", () => {
  it("a real name/phone from customerInfo persists exactly", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("sent1", graph.business.id, "cust1");
    state.selectedOfferId = "offer-couples-massage";

    compile(graph, state, emptyIR({ customerInfo: { name: "Inon", phone: "0558832177" } }));

    expect(state.knownFields.name).toBe("Inon");
    expect(state.knownFields.phone).toBe("0558832177");
  });

  it('a literal "null" sentinel for name/phone is rejected outright — never stored', () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("sent2", graph.business.id, "cust2");
    state.selectedOfferId = "offer-couples-massage";

    const outcome = compile(graph, state, emptyIR({ customerInfo: { name: "null", phone: "null" } }));

    expect(state.knownFields.name).toBeUndefined();
    expect(state.knownFields.phone).toBeUndefined();
    // The real behavior: still treated as missing, so BARRY asks for them —
    // never silently "succeeds" with garbage data on file.
    expect(outcome.kind).toBe("needs_info");
  });

  it("an empty string can never overwrite an already-known good value", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("sent3", graph.business.id, "cust3");
    state.selectedOfferId = "offer-couples-massage";
    state.knownFields.name = "Jordan Lee";

    compile(graph, state, emptyIR({ customerInfo: { name: "" } }));

    expect(state.knownFields.name).toBe("Jordan Lee");
  });

  it('a "null" sentinel can never overwrite an already-known good value', () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("sent4", graph.business.id, "cust4");
    state.selectedOfferId = "offer-couples-massage";
    state.knownFields.phone = "555-111-2222";

    compile(graph, state, emptyIR({ customerInfo: { phone: "null" } }));

    expect(state.knownFields.phone).toBe("555-111-2222");
  });

  it("a later CORRECTED phone (a real value) replaces the previous one", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("sent5", graph.business.id, "cust5");
    state.selectedOfferId = "offer-couples-massage";
    state.knownFields.phone = "555-111-2222";

    compile(graph, state, emptyIR({ customerInfo: { phone: "555-999-8888" } }));

    expect(state.knownFields.phone).toBe("555-999-8888");
  });

  it("CompileOutcome.debug.appliedCustomerInfo reflects exactly what was merged, post-filtering", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("sent6", graph.business.id, "cust6");
    state.selectedOfferId = "offer-couples-massage";

    const outcome = compile(
      graph,
      state,
      emptyIR({ customerInfo: { name: "Inon", phone: "null", email: "  " } })
    );

    expect(outcome.debug?.appliedCustomerInfo).toEqual({ name: "Inon" });
  });

  it("arbitrary custom customer-info field names still work (normalization is value-only)", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("sent7", graph.business.id, "cust7");

    compile(graph, state, emptyIR({ customerInfo: { preferredTherapist: "Alex", allergyNotes: "none" } }));

    expect(state.knownFields.preferredTherapist).toBe("Alex");
    // "none" is a sentinel — rejected even for a made-up field name.
    expect(state.knownFields.allergyNotes).toBeUndefined();
  });
});
