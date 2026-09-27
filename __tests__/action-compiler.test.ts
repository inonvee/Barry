import { describe, expect, it } from "vitest";
import { compile } from "@/lib/runtime/compiler";
import { handleCustomerMessage } from "@/lib/runtime";
import { createInitialConversationState } from "@/lib/state";
import type { BarryIR } from "@/lib/reasoner/ir";
import { resolveSchedulingWindow } from "@/lib/scheduling/resolver";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { buildPersonalTrainerGraph } from "@/lib/fixtures/personal-trainer";

// Spa fixture's business.timezone. Tests compute their own expected value
// through the same resolver rather than hardcoding a UTC string, so they
// stay correct if the resolver's conversion details ever change.
const SPA_TZ = "America/New_York";
function explicitAt(isoDate: string, hour: number, minute = 0) {
  return { date: { kind: "explicitDate" as const, isoDate }, time: { kind: "explicitTime" as const, hour, minute } };
}

function emptyIR(overrides: Partial<BarryIR> = {}): BarryIR {
  return { intent: "test", entities: {}, constraints: {}, knownFieldsUpdate: {}, ...overrides };
}

describe("Action Compiler: never call a tool with incomplete input", () => {
  it('"Couples" with no date asks for date/time and does NOT call checkAvailability', () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("c1", graph.business.id, "cust1");
    // Simulate name/phone already on file so this isolates the exact
    // reported failure: an offer is known, but no scheduling window is.
    state.knownFields.name = "Jordan Lee";
    state.knownFields.phone = "555-111-2222";

    const outcome = compile(graph, state, emptyIR({ selectedOfferId: "offer-couples-massage" }));

    expect(outcome.kind).toBe("ask_datetime");
    if (outcome.kind === "ask_datetime") expect(outcome.offerName).toBe("Couples Massage");
  });

  it('"I wanna come with my wife on Sunday at 2pm" compiles partySize 2 + a valid checkAvailability call', () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("c2", graph.business.id, "cust2");
    state.knownFields.name = "Jordan Lee";
    state.knownFields.phone = "555-111-2222";
    state.selectedOfferId = "offer-couples-massage";

    const schedulingWindow = explicitAt("2026-10-04", 14); // a Sunday, 2pm
    const expected = resolveSchedulingWindow(schedulingWindow, SPA_TZ)!;
    const outcome = compile(graph, state, emptyIR({ constraints: { schedulingWindow, partySize: 2 } }));

    expect(outcome.kind).toBe("action");
    if (outcome.kind === "action") {
      expect(outcome.action.name).toBe("checkAvailability");
      expect(outcome.action.input.earliest).toBe(expected.earliest);
      expect(outcome.action.input.partySize).toBe(2);
    }
  });

  it("compiles a valid tool call from information supplied across multiple separate compile() calls", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("c3", graph.business.id, "cust3");
    state.knownFields.name = "Jordan Lee";
    state.knownFields.phone = "555-111-2222";

    const turn1 = compile(graph, state, emptyIR({ selectedOfferId: "offer-couples-massage" }));
    expect(turn1.kind).toBe("ask_datetime");

    const schedulingWindow = explicitAt("2026-10-04", 14);
    const expected = resolveSchedulingWindow(schedulingWindow, SPA_TZ)!;
    const turn2 = compile(graph, state, emptyIR({ constraints: { schedulingWindow } }));
    expect(turn2.kind).toBe("action");
    if (turn2.kind === "action") expect(turn2.action.input.earliest).toBe(expected.earliest);
  });

  it("replaces the scheduling constraint entirely when the customer changes their mind (Sunday -> Monday)", () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("c4", graph.business.id, "cust4");
    state.knownFields.name = "Jordan Lee";
    state.knownFields.phone = "555-111-2222";
    state.selectedOfferId = "offer-couples-massage";

    const sundayWindow = explicitAt("2026-10-04", 14);
    const mondayWindow = explicitAt("2026-10-05", 14);
    const expectedSunday = resolveSchedulingWindow(sundayWindow, SPA_TZ)!;
    const expectedMonday = resolveSchedulingWindow(mondayWindow, SPA_TZ)!;

    const first = compile(graph, state, emptyIR({ constraints: { schedulingWindow: sundayWindow } }));
    expect(first.kind).toBe("action");
    if (first.kind === "action") expect(first.action.input.earliest).toBe(expectedSunday.earliest);

    const second = compile(graph, state, emptyIR({ constraints: { schedulingWindow: mondayWindow } }));
    expect(second.kind).toBe("action");
    if (second.kind === "action") expect(second.action.input.earliest).toBe(expectedMonday.earliest);
  });

  it("never lets an incomplete tool call through, even from a corrupted/partial ConversationState", () => {
    const graph = buildPersonalTrainerGraph();
    const state = createInitialConversationState("c5", graph.business.id, "cust5");
    state.knownFields.name = "Casey Kim";
    state.knownFields.email = "casey@example.com";
    state.selectedOfferId = "offer-free-consult";
    // A slot was offered and accepted, but __offeredSlotResource never got
    // set (e.g. a bug elsewhere, or hand-crafted adversarial state) — the
    // compiler must refuse to call createBooking with a missing resourceId
    // rather than pass `resourceId: undefined` through to the tool.
    state.knownFields.__offeredSlotStart = "2026-10-04T09:00:00.000Z";
    state.knownFields.__offeredSlotEnd = "2026-10-04T09:30:00.000Z";
    state.knownFields.__slotAccepted = "1";

    const outcome = compile(graph, state, emptyIR());

    expect(outcome.kind).toBe("compiler_error");
  });

  it("valid natural-language scheduling produces the real availability action, not a generic fallback", async () => {
    const graph = buildSpaGraph();
    const conv = "c6";
    const customer = "cust6";

    await handleCustomerMessage(graph, conv, customer, "Couples");
    await handleCustomerMessage(graph, conv, customer, "Jordan Lee");
    const t = await handleCustomerMessage(graph, conv, customer, "555-111-2222 — I wanna come with my wife on Sunday at 2pm");

    expect(t.turn.selectedAction?.name).toBe("checkAvailability");
    expect((t.turn.selectedAction?.input as { partySize: number }).partySize).toBe(2);
    expect(t.response.toLowerCase()).not.toMatch(/say that again|could you tell me a bit more/);
    expect(t.turn.toolResult?.ok).toBe(true);
  });
});
