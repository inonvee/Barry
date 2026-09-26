import { describe, expect, it } from "vitest";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { buildPersonalTrainerGraph } from "@/lib/fixtures/personal-trainer";
import { getBackend } from "@/lib/store/memory-backend";

describe("scenario: personal trainer", () => {
  it("books a free consultation entirely on its own at 4am (24/7 principle)", async () => {
    const graph = buildPersonalTrainerGraph();
    const conv = "trainer-conv-1";
    const customer = "cust-trainer-1";

    await handleCustomerMessage(graph, conv, customer, "I'd like a free consultation Wednesday morning.");
    await handleCustomerMessage(graph, conv, customer, "Casey Kim");
    const afterEmail = await handleCustomerMessage(graph, conv, customer, "casey@example.com");
    expect(afterEmail.turn.selectedAction?.name).toBe("checkAvailability");

    const confirmed = await handleCustomerMessage(graph, conv, customer, "Yes, book it.");
    expect(confirmed.turn.selectedAction?.name).toBe("createBooking");
    expect(confirmed.state.outcome).toBe("won");
    expect(confirmed.state.stage).toBe("closed");
  });

  it("requires owner approval for any discount, since the automatic limit is zero", async () => {
    const graph = buildPersonalTrainerGraph();
    const conv = "trainer-conv-2";
    const customer = "cust-trainer-2";

    await handleCustomerMessage(
      graph,
      conv,
      customer,
      "Can I book a 1:1 training session Thursday? Could you do 5% off?"
    );
    await handleCustomerMessage(graph, conv, customer, "Drew Park");
    const afterEmail = await handleCustomerMessage(graph, conv, customer, "drew@example.com");
    expect(afterEmail.turn.selectedAction?.name).toBe("checkAvailability");

    const accept = await handleCustomerMessage(graph, conv, customer, "That works, sign me up.");
    expect(accept.turn.selectedAction?.name).toBe("createPaymentRequest");
    expect(accept.turn.policyDecision?.status).toBe("requires_approval");
    expect(accept.state.stage).toBe("escalated");

    const approvals = await getBackend().listApprovals(graph.business.id);
    const approval = approvals.find((a) => a.id === accept.state.pendingApprovalId)!;
    expect(approval).toBeTruthy();

    const declined = await resumeAfterApproval(graph, approval.id, "declined", "owner@trainer.com");
    expect(declined.response.toLowerCase()).toMatch(/wasn't able to approve|sorry/);
  });
});
