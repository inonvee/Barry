import { describe, expect, it } from "vitest";
import { handleCustomerMessage, handlePaymentOutcome } from "@/lib/runtime";
import { buildSpaGraph } from "@/lib/fixtures/spa";

describe("scenario: spa couples massage booking (no human involved)", () => {
  it("takes a customer from discovery to a confirmed, paid booking", async () => {
    const graph = buildSpaGraph();
    const conv = "spa-conv-1";
    const customer = "cust-spa-1";

    const t1 = await handleCustomerMessage(
      graph,
      conv,
      customer,
      "Hi, my girlfriend and I want a couples massage Friday around noon."
    );
    expect(t1.state.selectedOfferId).toBe("offer-couples-massage");
    expect(t1.state.stage).toBe("info_gathering");
    expect(t1.state.missingFields).toContain("name");

    const t2 = await handleCustomerMessage(graph, conv, customer, "Jordan Lee");
    expect(t2.state.knownFields.name).toBe("Jordan Lee");
    expect(t2.state.missingFields).toContain("phone");

    const t3 = await handleCustomerMessage(graph, conv, customer, "555-123-4567");
    expect(t3.state.stage).toBe("scheduling");
    expect(t3.turn.selectedAction?.name).toBe("checkAvailability");
    expect(t3.response.toLowerCase()).toMatch(/available|work for you/);

    const t4 = await handleCustomerMessage(graph, conv, customer, "That works, let's book it.");
    expect(t4.state.stage).toBe("payment");
    expect(t4.turn.selectedAction?.name).toBe("createPaymentRequest");
    const paymentRequestId = (t4.turn.toolResult?.output as { paymentRequestId: string }).paymentRequestId;
    expect(paymentRequestId).toBeTruthy();

    const t5 = await handlePaymentOutcome(graph, conv, paymentRequestId, "paid");
    expect(t5.state.stage).toBe("closed");
    expect(t5.state.outcome).toBe("won");
    expect(t5.turn.selectedAction?.name).toBe("createBooking");
  });

  it("gracefully handles a failed booking attempt (slot taken) and lets the customer pick another", async () => {
    const graph = buildSpaGraph();
    const conv = "spa-conv-2";
    const customer = "cust-spa-2";

    await handleCustomerMessage(graph, conv, customer, "I'd like a solo Swedish massage Monday morning.");
    await handleCustomerMessage(graph, conv, customer, "Alex Rivera");
    const afterPhone = await handleCustomerMessage(graph, conv, customer, "5551234567");
    const slotStart = afterPhone.state.knownFields.__offeredSlotStart;
    expect(slotStart).toBeTruthy();

    // A second customer books the exact same resource/slot first.
    const { callTool } = await import("@/lib/tools");
    const conflict = await callTool(
      "createBooking",
      {
        offerId: "offer-solo-massage",
        resourceId: afterPhone.state.knownFields.__offeredSlotResource,
        start: slotStart,
        end: afterPhone.state.knownFields.__offeredSlotEnd,
        partySize: 1,
      },
      { graph, conversationId: "other-conv", customerId: "other-cust" }
    );
    expect(conflict.ok).toBe(true);

    const accept = await handleCustomerMessage(graph, conv, customer, "Yes that works");
    // requiresPayment -> createPaymentRequest happens first, not createBooking directly.
    // Simulate paying, then the booking attempt should fail because the slot is gone.
    const paymentRequestId = (accept.turn.toolResult?.output as { paymentRequestId: string })?.paymentRequestId;
    expect(paymentRequestId).toBeTruthy();

    const afterPay = await handlePaymentOutcome(graph, conv, paymentRequestId, "paid");
    expect(afterPay.turn.selectedAction?.name).toBe("createBooking");
    expect(afterPay.turn.toolResult?.ok).toBe(false);
    expect(afterPay.response.toLowerCase()).toMatch(/issue|sorry/);
  });
});
