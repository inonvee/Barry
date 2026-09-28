import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InspectorPanel } from "@/components/InspectorPanel";
import { createInitialConversationState } from "@/lib/state";
import type { TurnLog } from "@/lib/state";

describe("InspectorPanel debug-layer labels", () => {
  it("labels raw Reasoner proposal, BARRY verified IR, and applied persistent state as distinct layers", () => {
    const state = createInitialConversationState("inspector-identity", "biz-1", "cust-1");
    state.knownFields.name = "ינון";
    state.missingFields = [];

    const turn: TurnLog = {
      id: "turn-1",
      at: "2026-09-27T00:00:00.000Z",
      customerMessage: "השם שלי זה ינון",
      understood: {
        intent: "provide_contact_info",
        entities: {},
        customerInfo: { name: "ינון" },
      },
      retrieved: { offerIds: [], knowledgeIds: [] },
      verification: {
        llmCustomerInfo: { name: "ינון" },
        rejected: [{ claim: "customerInfo.phone", value: "0501234567", reason: "no evidence in the customer's message" }],
      },
      compiled: {
        appliedCustomerInfo: { name: "ינון" },
      },
      response: "תודה ינון.",
      stateAfter: { stage: "info_gathering" },
      reasoner: "llm",
    };
    state.turns.push(turn);

    const html = renderToStaticMarkup(<InspectorPanel state={state} />);

    expect(html).toContain("Reasoner proposal");
    expect(html).toContain("BARRY verified IR");
    expect(html).toContain("CustomerInfo actually applied to persistent state");
    expect(html).not.toContain("customerInfo proposed by Reasoner");
    expect(html).toContain("Grounding rejected unsupported claims");
    expect(html).toContain("customerInfo.phone");
  });
});
