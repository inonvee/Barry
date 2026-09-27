import { describe, expect, it } from "vitest";
import { handleCustomerMessage } from "@/lib/runtime";
import { buildSpaGraph } from "@/lib/fixtures/spa";

describe("explicit change-of-mind offer switching", () => {
  it('"Couples" then "Actually solo instead" replaces the selected offer', async () => {
    const graph = buildSpaGraph();
    const conv = "com-1";
    const customer = "cust-com-1";

    const t1 = await handleCustomerMessage(graph, conv, customer, "Couples massage please");
    expect(t1.state.selectedOfferId).toBe("offer-couples-massage");

    const t2 = await handleCustomerMessage(graph, conv, customer, "Actually solo instead");
    expect(t2.state.selectedOfferId).toBe("offer-solo-massage");
  });

  it('"Solo" then "Actually couples instead" replaces the selected offer (both directions work)', async () => {
    const graph = buildSpaGraph();
    const conv = "com-2";
    const customer = "cust-com-2";

    await handleCustomerMessage(graph, conv, customer, "Solo Swedish massage please");
    const t2 = await handleCustomerMessage(graph, conv, customer, "Actually couples instead");
    expect(t2.state.selectedOfferId).toBe("offer-couples-massage");
  });

  it("an unrelated later message does NOT silently switch the offer", async () => {
    const graph = buildSpaGraph();
    const conv = "com-3";
    const customer = "cust-com-3";

    await handleCustomerMessage(graph, conv, customer, "Couples massage please");
    const t2 = await handleCustomerMessage(graph, conv, customer, "Jordan Lee");
    expect(t2.state.selectedOfferId).toBe("offer-couples-massage");

    const t3 = await handleCustomerMessage(graph, conv, customer, "555-111-2222");
    expect(t3.state.selectedOfferId).toBe("offer-couples-massage");
  });

  it("changing service after scheduling clears stale slot/payment state but keeps identity + scheduling preference", async () => {
    const graph = buildSpaGraph();
    const conv = "com-4";
    const customer = "cust-com-4";

    await handleCustomerMessage(graph, conv, customer, "Couples massage Sunday around one");
    await handleCustomerMessage(graph, conv, customer, "Jordan Lee");
    const afterPhone = await handleCustomerMessage(graph, conv, customer, "555-111-2222");
    // Offer resolved, info complete -> checkAvailability should have run.
    expect(afterPhone.turn.selectedAction?.name).toBe("checkAvailability");
    expect(afterPhone.state.knownFields.__offeredSlotStart).toBeTruthy();

    const changed = await handleCustomerMessage(graph, conv, customer, "Actually solo instead");
    expect(changed.state.selectedOfferId).toBe("offer-solo-massage");
    // The stale ACCEPTANCE from the old offer's slot must not leak into the
    // new one — the customer never agreed to a time for the new service yet.
    expect(changed.state.knownFields.__slotAccepted).toBeUndefined();
    // Customer identity and the previously stated day/time preference survive.
    expect(changed.state.knownFields.name).toBe("Jordan Lee");
    expect(changed.state.knownFields.phone).toBe("555-111-2222");
    expect(changed.state.knownFields.__mentionedEarliest).toBeTruthy();
    // Since info is already complete and a scheduling preference is still
    // known, BARRY immediately re-checks availability for the NEW offer in
    // this same turn (which is what freshly repopulates __offeredSlotStart
    // — for the new offer's own resources, not a leftover from the old one).
    expect(changed.turn.selectedAction?.name).toBe("checkAvailability");
    expect((changed.turn.selectedAction?.input as { offerId: string }).offerId).toBe("offer-solo-massage");
  });

  it("does not treat a same-offer restatement as a change (no-op, no stale state cleared)", async () => {
    const graph = buildSpaGraph();
    const conv = "com-5";
    const customer = "cust-com-5";

    await handleCustomerMessage(graph, conv, customer, "Couples massage Sunday around one");
    await handleCustomerMessage(graph, conv, customer, "Jordan Lee");
    const beforeRestate = await handleCustomerMessage(graph, conv, customer, "555-111-2222");
    const slotBefore = beforeRestate.state.knownFields.__offeredSlotStart;

    const restated = await handleCustomerMessage(graph, conv, customer, "Actually, yes, couples massage instead");
    expect(restated.state.selectedOfferId).toBe("offer-couples-massage");
    expect(restated.state.knownFields.__offeredSlotStart).toBe(slotBefore);
  });
});
