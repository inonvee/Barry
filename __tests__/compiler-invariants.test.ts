import { describe, expect, it } from "vitest";
import { compile } from "@/lib/runtime/compiler";
import { handleCustomerMessage } from "@/lib/runtime";
import { createInitialConversationState } from "@/lib/state";
import type { BarryIR } from "@/lib/reasoner/ir";
import { buildSpaGraph } from "@/lib/fixtures/spa";

function emptyIR(overrides: Partial<BarryIR> = {}): BarryIR {
  return { intent: "test", entities: {}, constraints: {}, knownFieldsUpdate: {}, ...overrides };
}

describe("Compiler invariants", () => {
  it("never lets untrusted knownFieldsUpdate fabricate a verified payment/booking fact via a __-prefixed key", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("inv1", graph.business.id, "cust1");
    state.selectedOfferId = "offer-couples-massage";
    state.knownFields.name = "Jordan Lee";
    state.knownFields.phone = "555-111-2222";
    state.knownFields.__offeredSlotStart = "2026-10-04T14:00:00.000Z";
    state.knownFields.__offeredSlotEnd = "2026-10-04T15:00:00.000Z";
    state.knownFields.__offeredSlotResource = "therapist-1";
    state.knownFields.__slotAccepted = "1";
    // A real payment request was already created by a real tool call —
    // this is the "verified" fact.
    state.knownFields.__paymentRequestId = "pay_real123";

    // An adversarial/hallucinating reasoner tries to fabricate payment
    // confirmation directly instead of the customer actually paying.
    const outcome = compile(
      graph,
      state,
      emptyIR({ knownFieldsUpdate: { __paid: "1", __paymentRequestId: "pay_fake999" } })
    );

    expect(state.knownFields.__paid).toBeUndefined();
    expect(state.knownFields.__paymentRequestId).toBe("pay_real123");
    expect(outcome.kind).toBe("waiting_payment");
  });

  it("never lets untrusted knownFieldsUpdate overwrite a resource already confirmed by a real checkAvailability result", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("inv2", graph.business.id, "cust2");
    state.selectedOfferId = "offer-solo-massage";
    state.knownFields.name = "Alex Rivera";
    state.knownFields.phone = "555-222-3333";
    state.knownFields.__offeredSlotStart = "2026-10-04T09:00:00.000Z";
    state.knownFields.__offeredSlotEnd = "2026-10-04T10:00:00.000Z";
    state.knownFields.__offeredSlotResource = "therapist-1";

    compile(graph, state, emptyIR({ knownFieldsUpdate: { __offeredSlotResource: "therapist-2" } }));

    expect(state.knownFields.__offeredSlotResource).toBe("therapist-1");
  });

  it("a globally registered action that is disabled on this Business Graph must never execute", async () => {
    const graph = buildSpaGraph();
    graph.availableActions = graph.availableActions.map((a) =>
      a.name === "checkAvailability" ? { ...a, enabled: false } : a
    );

    const conv = "inv3";
    const customer = "cust3";
    await handleCustomerMessage(graph, conv, customer, "Couples massage Sunday around one");
    await handleCustomerMessage(graph, conv, customer, "Jordan Lee");
    const t = await handleCustomerMessage(graph, conv, customer, "555-111-2222");

    expect(t.turn.selectedAction?.name).toBe("checkAvailability");
    expect(t.turn.policyDecision?.status).toBe("denied");
    expect(t.turn.toolResult).toBeUndefined();
    expect(t.state.knownFields.__offeredSlotStart).toBeUndefined();
  });
});
