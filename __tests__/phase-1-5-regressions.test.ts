import { describe, expect, it } from "vitest";
import { handleCustomerMessage, handlePaymentOutcome } from "@/lib/runtime";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { getBackend } from "@/lib/store";

describe("Phase 1.5 regressions", () => {
  it('"Hey" gets a generic discovery response, then remembering Sunday 13:00 narrows to which service', async () => {
    const graph = buildSpaGraph();
    const conv = "p15-1";
    const customer = "cust-p15-1";

    const t1 = await handleCustomerMessage(graph, conv, customer, "Hey");
    expect(t1.state.selectedOfferId).toBeUndefined();
    expect(t1.response.toLowerCase()).toMatch(/what you're looking for|help/);

    const t2 = await handleCustomerMessage(graph, conv, customer, "Are you available Sunday at 13:00?");
    expect(t2.state.knownFields.__mentionedEarliest).toBeTruthy();
    // Must NOT repeat the exact same generic discovery response as turn 1.
    expect(t2.response).not.toBe(t1.response);
    expect(t2.response.toLowerCase()).toMatch(/couples massage|solo swedish massage/);
  });

  it("an ambiguous request that matches no offer and no scheduling intent asks a clarifying question instead of guessing", async () => {
    const graph = buildSpaGraph();
    const t = await handleCustomerMessage(graph, "p15-2", "cust-p15-2", "xyzzy plugh quux");
    expect(t.state.selectedOfferId).toBeUndefined();
    expect(t.turn.selectedAction).toBeNull();
    expect(t.response.length).toBeGreaterThan(0);
  });

  it("does not fabricate an answer about something outside the Business Graph's knowledge", async () => {
    const graph = buildSpaGraph();
    const t = await handleCustomerMessage(
      graph,
      "p15-3",
      "cust-p15-3",
      "Do you validate parking at the airport garage?"
    );
    // No knowledge item matches "airport" — BARRY must fall back to the
    // generic offer list rather than inventing a parking policy answer.
    expect(t.turn.retrieved.knowledgeIds).toEqual([]);
    expect(t.response.toLowerCase()).not.toMatch(/airport/);
  });

  it("a failed payment does not create a booking", async () => {
    const graph = buildSpaGraph();
    const conv = "p15-4";
    const customer = "cust-p15-4";

    await handleCustomerMessage(graph, conv, customer, "Couples massage Sunday around one");
    await handleCustomerMessage(graph, conv, customer, "Jordan Lee");
    await handleCustomerMessage(graph, conv, customer, "555-999-8888");
    const accepted = await handleCustomerMessage(graph, conv, customer, "Yes that works");
    const paymentRequestId = (accepted.turn.toolResult?.output as { paymentRequestId: string })
      .paymentRequestId;

    const failed = await handlePaymentOutcome(graph, conv, paymentRequestId, "failed");
    expect(failed.state.outcome).not.toBe("won");
    expect(failed.state.stage).not.toBe("closed");
    expect(failed.turn.selectedAction).toBeUndefined();

    const bookings = await getBackend().listBookings(graph.business.id);
    expect(bookings.some((b) => b.conversationId === conv)).toBe(false);
  });

  it("handles a Hebrew message without crashing and without inventing a response", async () => {
    const graph = buildSpaGraph();
    const t = await handleCustomerMessage(graph, "p15-5", "cust-p15-5", "שלום, אני רוצה לקבוע עיסוי בשעה 13:00 ביום ראשון");
    expect(t.response.length).toBeGreaterThan(0);
    expect(t.state.stage).toBeDefined();
  });
});
