import { describe, expect, it } from "vitest";
import { handleCustomerMessage, handlePaymentOutcome, resumeAfterApproval } from "@/lib/runtime";
import { buildGarageGraph } from "@/lib/fixtures/garage";
import { getBackend } from "@/lib/store";

describe("scenario: garage / automotive service", () => {
  it("books a free brake inspection with zero human involvement (no payment required)", async () => {
    const graph = buildGarageGraph();
    const conv = "garage-conv-1";
    const customer = "cust-garage-1";

    await handleCustomerMessage(graph, conv, customer, "Can I get a brake inspection Tuesday morning?");
    await handleCustomerMessage(graph, conv, customer, "Sam Torres");
    const afterPhone = await handleCustomerMessage(graph, conv, customer, "555-000-1111");
    expect(afterPhone.turn.selectedAction?.name).toBe("checkAvailability");

    const confirmed = await handleCustomerMessage(graph, conv, customer, "Yes, that time works.");
    expect(confirmed.turn.selectedAction?.name).toBe("createBooking");
    expect(confirmed.state.outcome).toBe("won");
    expect(confirmed.state.stage).toBe("closed");
  });

  it("escalates an oversized discount on an oil change to the owner for approval", async () => {
    const graph = buildGarageGraph();
    const conv = "garage-conv-2";
    const customer = "cust-garage-2";

    await handleCustomerMessage(graph, conv, customer, "I need an oil change Tuesday morning, any chance of 15% off?");
    await handleCustomerMessage(graph, conv, customer, "Priya Nair");
    const afterPhone = await handleCustomerMessage(graph, conv, customer, "555-222-3333");
    expect(afterPhone.turn.selectedAction?.name).toBe("checkAvailability");

    const accept = await handleCustomerMessage(graph, conv, customer, "Sounds good, book it.");
    expect(accept.turn.policyDecision?.status).toBe("requires_approval");
    expect(accept.state.stage).toBe("escalated");

    const approvals = await getBackend().listApprovals(graph.business.id);
    const approval = approvals.find((a) => a.id === accept.state.pendingApprovalId)!;

    const resumed = await resumeAfterApproval(graph, approval.id, "approved", "owner@garage.com");
    expect(resumed.turn.selectedAction?.name).toBe("createPaymentRequest");
    const paymentRequestId = (resumed.turn.toolResult?.output as { paymentRequestId: string }).paymentRequestId;

    const paid = await handlePaymentOutcome(graph, conv, paymentRequestId, "paid");
    expect(paid.turn.selectedAction?.name).toBe("createBooking");
    expect(paid.state.outcome).toBe("won");
  });
});
