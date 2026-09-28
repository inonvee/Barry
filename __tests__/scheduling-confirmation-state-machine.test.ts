import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { buildPersonalTrainerGraph } from "@/lib/fixtures/personal-trainer";
import { compile } from "@/lib/runtime/compiler";
import { verifyIR } from "@/lib/reasoner/verify";
import { MockReasoner } from "@/lib/reasoner/mock-reasoner";
import type { BusinessGraph } from "@/lib/business-graph";
import type { BarryIR } from "@/lib/reasoner/ir";
import { resolveSchedulingWindow } from "@/lib/scheduling/resolver";
import { createInitialConversationState, type ConversationState } from "@/lib/state";

function emptyIR(overrides: Partial<BarryIR> = {}): BarryIR {
  return { intent: "test", entities: {}, constraints: {}, customerInfo: {}, ...overrides };
}

/** Short-reply understanding is the model's job; MockReasoner stands in for it offline. verifyIR only grounds it against state. */
async function understandAndGround(graph: BusinessGraph, text: string, state: ConversationState) {
  const ir = await new MockReasoner().understand({ graph, state, customerMessage: text });
  return verifyIR(graph, text, ir, state);
}

function bookedState(conversationId: string): ConversationState {
  const graph = buildSpaGraph();
  const state = createInitialConversationState(conversationId, graph.business.id, `cust-${conversationId}`);
  state.selectedOfferId = "offer-couples-massage";
  state.knownFields.name = "Inon";
  state.knownFields.phone = "0501234567";
  state.knownFields.__offeredSlotStart = "2026-10-08T17:00:00.000Z"; // Oct 8, 2026 13:00 in New York
  state.knownFields.__offeredSlotEnd = "2026-10-08T18:00:00.000Z";
  state.knownFields.__offeredSlotResource = "therapist-1";
  state.knownFields.__mentionedEarliest = "2026-10-08T17:00:00.000Z";
  state.knownFields.__mentionedLatest = "2026-10-08T20:00:00.000Z";
  state.knownFields.__lastSchedulingDate = JSON.stringify({ kind: "explicitDate", isoDate: "2026-10-08" });
  return state;
}

describe("scheduling confirmation state machine", () => {
  it("a time-only correction after an offered slot clears the stale offer and checks the corrected time", () => {
    const graph = buildSpaGraph();
    const state = bookedState("sched-sm-time");

    const outcome = compile(
      graph,
      state,
      emptyIR({ constraints: { schedulingWindow: { time: { kind: "explicitTime", hour: 14, minute: 0 } } } })
    );

    expect(outcome.kind).toBe("action");
    expect(outcome.kind === "action" ? outcome.action.name : null).toBe("checkAvailability");
    expect(outcome.kind === "action" ? outcome.action.input.earliest : null).toBe("2026-10-08T18:00:00.000Z");
    expect(state.knownFields.__offeredSlotStart).toBeUndefined();
    expect(state.knownFields.__offeredSlotEnd).toBeUndefined();
    expect(state.knownFields.__offeredSlotResource).toBeUndefined();
    expect(state.knownFields.__slotAccepted).toBeUndefined();
  });

  it("a date correction after an offered slot clears the stale offer and checks the corrected date", () => {
    const graph = buildSpaGraph();
    const state = bookedState("sched-sm-date");

    const outcome = compile(
      graph,
      state,
      emptyIR({
        constraints: {
          schedulingWindow: {
            date: { kind: "explicitDate", isoDate: "2026-10-09" },
            time: { kind: "explicitTime", hour: 13, minute: 0 },
          },
        },
      })
    );

    expect(outcome.kind).toBe("action");
    expect(outcome.kind === "action" ? outcome.action.name : null).toBe("checkAvailability");
    expect(outcome.kind === "action" ? outcome.action.input.earliest : null).toBe("2026-10-09T17:00:00.000Z");
    expect(state.knownFields.__offeredSlotStart).toBeUndefined();
  });

  it("a date-and-time correction after an offered slot clears the stale offer and checks the corrected instant", () => {
    const graph = buildSpaGraph();
    const state = bookedState("sched-sm-date-time");

    const outcome = compile(
      graph,
      state,
      emptyIR({
        constraints: {
          schedulingWindow: {
            date: { kind: "explicitDate", isoDate: "2026-10-09" },
            time: { kind: "explicitTime", hour: 14, minute: 0 },
          },
        },
      })
    );

    expect(outcome.kind).toBe("action");
    expect(outcome.kind === "action" ? outcome.action.name : null).toBe("checkAvailability");
    expect(outcome.kind === "action" ? outcome.action.input.earliest : null).toBe("2026-10-09T18:00:00.000Z");
    expect(state.knownFields.__offeredSlotStart).toBeUndefined();
  });

  it("does not clear the offered slot when the customer merely confirms it", () => {
    const graph = buildSpaGraph();
    const state = bookedState("sched-sm-confirm");

    const outcome = compile(graph, state, emptyIR({ constraints: { slotAccepted: true } }));

    expect(state.knownFields.__offeredSlotStart).toBe("2026-10-08T17:00:00.000Z");
    expect(state.knownFields.__slotAccepted).toBe("1");
    expect(outcome.kind).toBe("action");
    expect(outcome.kind === "action" ? outcome.action.name : null).toBe("createPaymentRequest");
  });

  it("understood short confirmations become slotAccepted while a slot is awaiting confirmation", async () => {
    const graph = buildSpaGraph();
    for (const reply of ["כן", "מאשר", "yes", "confirm"]) {
      const state = bookedState(`sched-sm-accept-${reply}`);
      const { verified } = await understandAndGround(graph, reply, state);
      expect(verified.constraints.slotAccepted).toBe(true);
    }
  });

  it("understood short declines become slotDeclined while a slot is awaiting confirmation", async () => {
    const graph = buildSpaGraph();
    for (const reply of ["לא", "לא מתאים", "no", "nope"]) {
      const state = bookedState(`sched-sm-decline-${reply}`);
      const { verified } = await understandAndGround(graph, reply, state);
      expect(verified.constraints.slotDeclined).toBe(true);
      expect(verified.constraints.slotAccepted).toBeUndefined();
    }
  });

  it("grounding drops accept/decline claims when no slot is awaiting confirmation (state, not text, decides)", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("sched-sm-no-context", graph.business.id, "cust-no-context");

    const accepted = verifyIR(graph, "כן", emptyIR({ constraints: { slotAccepted: true } }), state);
    const declined = verifyIR(graph, "לא", emptyIR({ constraints: { slotDeclined: true } }), state);
    expect(accepted.verified.constraints.slotAccepted).toBeUndefined();
    expect(declined.verified.constraints.slotDeclined).toBeUndefined();
    expect(accepted.verification.rejected.map((r) => r.claim)).toContain("slotAccepted");
  });

  it("verifyIR never turns a bare short reply into a decision the model didn't make", () => {
    const graph = buildSpaGraph();
    const state = bookedState("sched-sm-no-inject");
    expect(verifyIR(graph, "כן", emptyIR(), state).verified.constraints.slotAccepted).toBeUndefined();
    expect(verifyIR(graph, "no", emptyIR(), state).verified.constraints.slotDeclined).toBeUndefined();
  });

  it("a contextual yes on a no-payment scheduled offer compiles createBooking instead of repeating confirmation", async () => {
    const graph = buildPersonalTrainerGraph();
    const state = createInitialConversationState("sched-sm-free-consult", graph.business.id, "cust-free-consult");
    state.selectedOfferId = "offer-free-consult";
    state.knownFields.name = "Inon";
    state.knownFields.email = "inon@example.com";
    state.knownFields.__offeredSlotStart = "2026-10-08T18:00:00.000Z"; // Oct 8, 2026 12:00 in Denver
    state.knownFields.__offeredSlotEnd = "2026-10-08T18:30:00.000Z";
    state.knownFields.__offeredSlotResource = "trainer-riley";

    const { verified } = await understandAndGround(graph, "Yes", state);
    const outcome = compile(graph, state, verified);

    expect(outcome.kind).toBe("action");
    expect(outcome.kind === "action" ? outcome.action.name : null).toBe("createBooking");
  });

  it("a corrected requested time is not mistaken for the old offered slot", () => {
    const graph = buildSpaGraph();
    const state = bookedState("sched-sm-mutation-check");
    const corrected = resolveSchedulingWindow(
      {
        date: { kind: "explicitDate", isoDate: "2026-10-08" },
        time: { kind: "explicitTime", hour: 14, minute: 0 },
      },
      graph.business.timezone
    );

    expect(corrected?.earliest).toBe("2026-10-08T18:00:00.000Z");
    expect(corrected?.earliest).not.toBe(state.knownFields.__offeredSlotStart);
  });
});
