import { describe, expect, it } from "vitest";
import { handleCustomerMessage } from "@/lib/runtime";
import { buildSpaGraph } from "@/lib/fixtures/spa";

describe("multi-turn entity accumulation (regression)", () => {
  it("retains a day/time mentioned before the offer is known, and doesn't repeat the generic discovery response", async () => {
    const graph = buildSpaGraph();
    const conv = "mt-1";
    const customer = "cust-mt-1";

    const t1 = await handleCustomerMessage(graph, conv, customer, "Are you available Sunday at 13:00?");
    // Not a generic "tell me what you're looking for" — BARRY should narrow
    // by which offers actually require scheduling.
    expect(t1.response.toLowerCase()).toMatch(/couples massage|solo swedish massage/);
    expect(t1.state.selectedOfferId).toBeUndefined();
    expect(t1.state.knownFields.__mentionedEarliest).toBeTruthy();

    const t2 = await handleCustomerMessage(graph, conv, customer, "Couples");
    expect(t2.state.selectedOfferId).toBe("offer-couples-massage");
    // "Couples" must never be captured as the customer's name.
    expect(t2.state.knownFields.name).toBeUndefined();
    expect(t2.response.toLowerCase()).not.toMatch(/tell me a bit more about what you're looking for/);

    const t3 = await handleCustomerMessage(graph, conv, customer, "Jordan Lee");
    expect(t3.state.knownFields.name).toBe("Jordan Lee");

    const t4 = await handleCustomerMessage(graph, conv, customer, "555-111-2222");
    // The originally-mentioned Sunday 13:00 must survive all the way through
    // info-gathering and drive the actual availability check.
    expect(t4.turn.selectedAction?.name).toBe("checkAvailability");
    expect((t4.turn.selectedAction?.input as { earliest: string }).earliest).toBe(
      t1.state.knownFields.__mentionedEarliest
    );
  });

  it("understands service + day + time in a single message", async () => {
    const graph = buildSpaGraph();
    const t = await handleCustomerMessage(
      graph,
      "mt-2",
      "cust-mt-2",
      "Couples massage Sunday around one"
    );
    expect(t.state.selectedOfferId).toBe("offer-couples-massage");
    expect(t.state.knownFields.__mentionedEarliest).toBeTruthy();
    expect(new Date(t.state.knownFields.__mentionedEarliest).getUTCHours()).toBe(13);
  });

  it("understands party size and time-of-day phrased conversationally, then resolves once the service is named", async () => {
    const graph = buildSpaGraph();
    const conv = "mt-3";
    const customer = "cust-mt-3";

    // No offer is named, but "for two" + a time-of-day are both real signal
    // that must not be dropped — this business has two schedulable
    // services, so BARRY asks which one instead of guessing.
    const t1 = await handleCustomerMessage(
      graph,
      conv,
      customer,
      "I want something for me and my girlfriend Sunday afternoon"
    );
    expect(t1.state.selectedOfferId).toBeUndefined();
    expect(t1.state.knownFields.__mentionedPartySize).toBe("2");
    expect(t1.response.toLowerCase()).toMatch(/couples massage|solo swedish massage/);

    const t2 = await handleCustomerMessage(graph, conv, customer, "the couples one");
    expect(t2.state.selectedOfferId).toBe("offer-couples-massage");
    expect(t2.state.knownFields.__mentionedPartySize).toBe("2");
  });

  it("lets the customer change their mind about the day", async () => {
    const graph = buildSpaGraph();
    const conv = "mt-4";
    const customer = "cust-mt-4";
    const t1 = await handleCustomerMessage(graph, conv, customer, "Couples massage Sunday around one");
    const sundayEarliest = t1.state.knownFields.__mentionedEarliest;

    const t2 = await handleCustomerMessage(graph, conv, customer, "Actually make it Monday.");
    expect(t2.state.knownFields.__mentionedEarliest).not.toBe(sundayEarliest);
    expect(new Date(t2.state.knownFields.__mentionedEarliest).getUTCDay()).toBe(1); // Monday
  });
});
