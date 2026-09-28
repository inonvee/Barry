import { describe, expect, it } from "vitest";
import { handleCustomerMessage, handlePaymentOutcome, resumeAfterApproval } from "@/lib/runtime";
import { buildEcommerceBagsGraph } from "@/lib/fixtures/ecommerce-bags";
import { getBackend } from "@/lib/store";

describe("scenario: ecommerce bag store", () => {
  it("completes a purchase end-to-end with no human intervention", async () => {
    const graph = buildEcommerceBagsGraph();
    const conv = "ecom-conv-1";
    const customer = "cust-ecom-1";

    const t1 = await handleCustomerMessage(graph, conv, customer, "I'd like to buy the Commuter Backpack.");
    expect(t1.state.selectedOfferId).toBe("offer-backpack");
    expect(t1.state.missingFields).toContain("email");

    // "I'd like to buy" was the decision: with the email in hand, BARRY checks
    // stock and sends the payment link in one turn.
    const t3 = await handleCustomerMessage(graph, conv, customer, "shopper@example.com");
    expect(t3.turn.trace?.steps.map((s) => s.action)).toEqual(["checkInventory", "createPaymentRequest"]);
    expect(t3.turn.selectedAction?.name).toBe("createPaymentRequest");
    const paymentRequestId = (t3.turn.toolResult?.output as { paymentRequestId: string }).paymentRequestId;

    const t4 = await handlePaymentOutcome(graph, conv, paymentRequestId, "paid");
    expect(t4.turn.selectedAction?.name).toBe("fulfillOrder");
    expect(t4.state.outcome).toBe("won");
    expect(t4.state.stage).toBe("closed");
  });

  it("tells the customer when an item is out of stock instead of taking payment", async () => {
    const graph = buildEcommerceBagsGraph(); // SKU-TOTE has 0 stock
    const conv = "ecom-conv-2";
    const customer = "cust-ecom-2";

    await handleCustomerMessage(graph, conv, customer, "Do you have the Everyday Tote?");
    await handleCustomerMessage(graph, conv, customer, "buyer@example.com");
    const t3 = await handleCustomerMessage(graph, conv, customer, "I'll take it");
    expect(t3.turn.selectedAction?.name).toBe("checkInventory");
    expect(t3.response.toLowerCase()).toMatch(/out of stock/);
  });

  it("escalates a large discount request to the owner, then resumes after approval", async () => {
    const graph = buildEcommerceBagsGraph();
    const conv = "ecom-conv-3";
    const customer = "cust-ecom-3";

    await handleCustomerMessage(graph, conv, customer, "I want the Weekender Duffel, can I get 25% off?");
    await handleCustomerMessage(graph, conv, customer, "vip@example.com"); // triggers checkInventory
    const t = await handleCustomerMessage(graph, conv, customer, "Great, let's buy it");

    expect(t.turn.policyDecision?.status).toBe("requires_approval");
    expect(t.state.pendingApprovalId).toBeTruthy();
    expect(t.response.toLowerCase()).toMatch(/owner|approv/);

    const approvals = await getBackend().listApprovals(graph.business.id);
    const approval = approvals.find((a) => a.id === t.state.pendingApprovalId)!;
    expect(approval.requestedAction).toBe("createPaymentRequest");

    const resumed = await resumeAfterApproval(graph, approval.id, "approved", "owner@business.com");
    expect(resumed.turn.selectedAction?.name).toBe("createPaymentRequest");
    expect(resumed.turn.toolResult?.ok).toBe(true);
    expect(resumed.state.pendingApprovalId).toBeNull();
  });
});
