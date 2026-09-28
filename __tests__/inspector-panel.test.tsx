import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InspectorPanel } from "@/components/InspectorPanel";
import { createInitialConversationState } from "@/lib/state";
import type { TurnLog } from "@/lib/state";

function baseTurn(overrides: Partial<TurnLog> = {}): TurnLog {
  return {
    id: "turn-1",
    at: "2026-09-27T00:00:00.000Z",
    customerMessage: "0558832177",
    understood: { intent: "provide_details", entities: {}, customerInfo: { phone: "0558832177" }, purchaseDecision: true, commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } } },
    retrieved: { offerIds: [], knowledgeIds: [] },
    response: "מעולה, הנה קישור לתשלום.",
    stateAfter: { stage: "payment" },
    reasoner: "llm",
    ...overrides,
  };
}

describe("InspectorPanel: the QA view of a turn", () => {
  it("shows each customer fact as proposed / evidence / verdict / applied — by plain field name", () => {
    const state = createInitialConversationState("inspector-identity", "biz-1", "cust-1");
    state.turns.push(
      baseTurn({
        verification: {
          llmCustomerInfo: { phone: "0558832177" },
          rejected: [{ claim: 'customerInfo["customerInfo.name"]', value: "x", reason: "not a plain field name" }],
          customerFacts: [
            { field: "phone", value: "0558832177", evidence: "0558832177", status: "accepted" },
            { field: "customerInfo.name", value: "x", evidence: "x", status: "rejected", reason: "not a plain field name" },
          ],
        },
        compiled: { appliedCustomerInfo: { phone: "0558832177" } },
      })
    );
    const html = renderToStaticMarkup(<InspectorPanel state={state} />);
    expect(html).toContain("Customer facts");
    expect(html).toContain("applied");
    expect(html).toContain("not a plain field name");
    expect(html).toContain("Purchase decision");
    expect(html).toContain("previous_result #1"); // 1-based, as the customer saw it
    expect(html).not.toContain("customerInfo.customerInfo");
  });

  it("shows both models, effort, runtime + constitution, steps with provider and policy, stop reason, reply contract and what BARRY saw", () => {
    const state = createInitialConversationState("inspector-trace", "biz-1", "cust-1");
    state.knownFields.__commerceCartId = "cart_1";
    state.knownFields.__paymentRequestId = "pr_1";
    state.turns.push(
      baseTurn({
        trace: {
          runtime: { barryVersion: "barry-runtime/1", commit: "abcdef123456", constitutionVersion: "c-7", reasoner: "llm", model: "gpt-5.6-sol", composerModel: "gpt-4o-mini", reasoningEffort: "low", composerReasoningEffort: null },
          rejectedClaims: [],
          steps: [
            { trigger: "customer", action: "createCommerceCheckout", capabilities: [{ capability: "checkout", provider: "memory" }], policy: { status: "allowed", reason: "ok" }, result: { ok: true }, stageBefore: "cart", stageAfter: "payment", stateKeysChanged: ["__paymentRequestId", "phone"] },
          ],
          stop: { reason: "needs_customer", outcome: "action" },
          reply: { language: "he", basis: "recent_turn", fallback: "missing-field contract: asks for \"name\", which is not missing" },
          missingFields: [],
          context: { shown: [{ position: 1, title: "Onyx Slip Dress" }], cart: { lines: [{ position: 1, title: "Onyx Slip Dress", options: { size: "M" }, quantity: 1 }], total: "390 ILS" } },
        },
      })
    );
    const html = renderToStaticMarkup(<InspectorPanel state={state} />);
    for (const text of ["gpt-5.6-sol", "effort low", "gpt-4o-mini", "barry-runtime/1", "c-7", "createCommerceCheckout", "checkout: memory", "__paymentRequestId, phone", "needs_customer", "recent turn", "missing-field contract", "#1", "390 ILS", "not verified"]) {
      expect(html).toContain(text);
    }
    // Key NAMES only — the trace never carries values, and the view adds none from it.
    expect(html).not.toContain("pr_1");
  });
});
