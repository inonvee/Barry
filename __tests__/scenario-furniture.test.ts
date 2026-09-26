import { describe, expect, it } from "vitest";
import { handleCustomerMessage, handlePaymentOutcome } from "@/lib/runtime";
import { buildFurnitureStoreGraph } from "@/lib/fixtures/furniture-store";

describe("scenario: furniture store", () => {
  it("qualifies a lead for a custom furniture order instead of transacting immediately", async () => {
    const graph = buildFurnitureStoreGraph();
    const conv = "furniture-conv-1";
    const customer = "cust-furniture-1";

    await handleCustomerMessage(graph, conv, customer, "I'd like a custom order for a dining bench.");
    await handleCustomerMessage(graph, conv, customer, "Morgan Blake");
    const afterEmail = await handleCustomerMessage(graph, conv, customer, "morgan@example.com");

    expect(afterEmail.turn.selectedAction?.name).toBe("createLead");
    expect(afterEmail.state.outcome).toBe("pending");
    expect(afterEmail.state.stage).toBe("closed");
  });

  it("completes an in-stock sofa purchase with no human intervention", async () => {
    const graph = buildFurnitureStoreGraph();
    const conv = "furniture-conv-2";
    const customer = "cust-furniture-2";

    await handleCustomerMessage(graph, conv, customer, "I'll take the Harlow sofa.");
    await handleCustomerMessage(graph, conv, customer, "Taylor Reed");
    const afterEmail = await handleCustomerMessage(graph, conv, customer, "taylor@example.com");
    expect(afterEmail.turn.selectedAction?.name).toBe("checkInventory");

    const buy = await handleCustomerMessage(graph, conv, customer, "Let's do it.");
    expect(buy.turn.selectedAction?.name).toBe("createPaymentRequest");
    const paymentRequestId = (buy.turn.toolResult?.output as { paymentRequestId: string }).paymentRequestId;

    const paid = await handlePaymentOutcome(graph, conv, paymentRequestId, "paid");
    expect(paid.turn.selectedAction?.name).toBe("fulfillOrder");
    expect(paid.state.outcome).toBe("won");
  });
});
