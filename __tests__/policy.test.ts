import { describe, expect, it } from "vitest";
import { decide } from "@/lib/policy";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { buildPersonalTrainerGraph } from "@/lib/fixtures/personal-trainer";

describe("policy engine", () => {
  it("allows a booking when bookings_auto_allowed is true", () => {
    const graph = buildSpaGraph();
    const decision = decide(graph, { action: "createBooking", params: { offerId: "offer-solo-massage" } });
    expect(decision.status).toBe("allowed");
  });

  it("allows a discount within the automatic limit", () => {
    const graph = buildSpaGraph();
    const decision = decide(graph, {
      action: "createPaymentRequest",
      params: { amount: 100, discountPct: 3 },
    });
    expect(decision.status).toBe("allowed");
  });

  it("requires approval when a discount exceeds the automatic limit", () => {
    const graph = buildSpaGraph();
    const decision = decide(graph, {
      action: "createPaymentRequest",
      params: { amount: 100, discountPct: 10 },
    });
    expect(decision.status).toBe("requires_approval");
    expect(decision.policyId).toBe("max_auto_discount_pct");
  });

  it("requires approval for any discount when the auto limit is zero", () => {
    const graph = buildPersonalTrainerGraph();
    const decision = decide(graph, {
      action: "createPaymentRequest",
      params: { amount: 80, discountPct: 5 },
    });
    expect(decision.status).toBe("requires_approval");
  });

  it("requires approval when payment amount exceeds the automatic cap", () => {
    const graph = buildSpaGraph();
    const decision = decide(graph, {
      action: "createPaymentRequest",
      params: { amount: 5000 },
    });
    expect(decision.status).toBe("requires_approval");
    expect(decision.policyId).toBe("max_auto_payment_amount");
  });

  it("requires approval for custom pricing when the policy demands it", () => {
    const graph = buildSpaGraph();
    const decision = decide(graph, {
      action: "createPaymentRequest",
      params: { amount: 50, isCustomPrice: true },
    });
    expect(decision.status).toBe("requires_approval");
    expect(decision.policyId).toBe("custom_pricing_requires_approval");
  });

  it("denies an action that isn't in the business's availableActions", () => {
    const graph = buildPersonalTrainerGraph();
    const decision = decide(graph, { action: "checkInventory", params: {} });
    expect(decision.status).toBe("denied");
  });
});
