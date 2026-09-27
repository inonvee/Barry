import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import type { ConversationState } from "@/lib/state";
import { runScenario } from "./support/eval-harness";

/**
 * MEGA RELIABILITY MISSION — Part 3: conversation order permutations.
 * The same four pieces of information (service, date/time, name, phone)
 * arriving in every possible order must converge to the SAME semantic
 * final state. BARRY must never behave like a rigid form that only
 * accepts fields in one fixed sequence.
 */

type FieldKey = "service" | "datetime" | "name" | "phone";

const FIELD_MESSAGE: Record<FieldKey, string> = {
  service: "Couples massage please",
  datetime: "Tuesday at 3pm",
  name: "My name is Inon",
  phone: "My phone number is 0501234567",
};

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([items[i], ...perm]);
    }
  }
  return result;
}

const ALL_ORDERS = permutations<FieldKey>(["service", "datetime", "name", "phone"]);

function assertConverged(state: ConversationState): void {
  expect(state.selectedOfferId).toBe("offer-couples-massage");
  expect(state.knownFields.name).toBe("Inon");
  expect(state.knownFields.phone).toBe("0501234567");
  expect(state.missingFields).toEqual([]);
  expect(state.knownFields.__mentionedEarliest).toBeTruthy();
  expect(new Date(state.knownFields.__mentionedEarliest).getUTCDay()).toBe(2); // Tuesday
}

describe("Order permutations: service/date-time/name/phone converge regardless of arrival order", () => {
  it(`covers all ${ALL_ORDERS.length} permutations of the four fields (>= dozens required)`, () => {
    expect(ALL_ORDERS.length).toBeGreaterThanOrEqual(24);
  });

  for (const order of ALL_ORDERS) {
    it(`order: ${order.join(" -> ")}`, async () => {
      const { state } = await runScenario({
        name: `order-${order.join("-")}`,
        graph: buildSpaGraph,
        turns: order.map((key) => ({ customer: FIELD_MESSAGE[key] })),
      });
      assertConverged(state);
    });
  }
});

describe("Order permutations: all fields in one message", () => {
  it("a single message containing every field resolves fully in one turn", async () => {
    const { state, turns } = await runScenario({
      name: "all-in-one-message",
      graph: buildSpaGraph,
      turns: [
        {
          customer:
            "Couples massage Tuesday at 3pm, my name is Inon and my phone number is 0501234567",
        },
      ],
    });
    assertConverged(state);
    // Should proceed straight to checking availability — no info-gathering detour.
    expect(turns[0].selectedAction?.name).toBe("checkAvailability");
  });
});

describe("Order permutations: partial fields in a deliberately weird order across many short turns", () => {
  it("phone, then a stray unrelated question, then service, then name, then date/time", async () => {
    const { state } = await runScenario({
      name: "weird-order-1",
      graph: buildSpaGraph,
      turns: [
        { customer: "My phone number is 0501234567" },
        { customer: "How much is it?" }, // service still unknown — a fact question, not a field
        { customer: "Couples massage please" },
        { customer: "My name is Inon" },
        { customer: "Tuesday at 3pm" },
      ],
    });
    assertConverged(state);
  });

  it("date/time before service is even chosen, then service, then identity in one message", async () => {
    const { state } = await runScenario({
      name: "weird-order-2",
      graph: buildSpaGraph,
      turns: [
        { customer: "Tuesday at 3pm" }, // scheduling intent narrows candidates but doesn't pick an offer
        { customer: "the couples one" },
        { customer: "My name is Inon and my phone number is 0501234567" },
      ],
    });
    assertConverged(state);
  });
});
