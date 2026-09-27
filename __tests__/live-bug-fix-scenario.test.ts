import { describe, expect, it } from "vitest";
import { handleCustomerMessage } from "@/lib/runtime";
import { buildSpaGraph } from "@/lib/fixtures/spa";

/**
 * LIVE Phase 1.5 Bug Fix Mission — exact verification scenario, run
 * end-to-end through the real runtime (MockReasoner, since no OpenAI key
 * is configured for this test run). This is the mission's own acceptance
 * test: Phase 1.5 isn't complete until this is clean.
 *
 *   Hey
 *   Couples
 *   How much is it?
 *   I wanna come with my wife Sunday at 1pm
 *   My name is Inon and my phone number is 0558832177
 */
describe("Live bug-fix verification scenario", () => {
  it("resolves price, scheduling, party size, and customer identity correctly across the exact live turns", async () => {
    const graph = buildSpaGraph();
    const conv = "live-bug-fix";
    const customer = "cust-live-bug-fix";

    const t1 = await handleCustomerMessage(graph, conv, customer, "Hey");
    expect(t1.state.selectedOfferId).toBeUndefined();

    const t2 = await handleCustomerMessage(graph, conv, customer, "Couples");
    expect(t2.state.selectedOfferId).toBe("offer-couples-massage");

    // BUG 3 context / fact-before-gate: price answered immediately, with
    // NO name/phone on file yet.
    const t3 = await handleCustomerMessage(graph, conv, customer, "How much is it?");
    expect(t3.response).toMatch(/220/);
    expect(t3.state.knownFields.name).toBeUndefined();
    expect(t3.state.knownFields.phone).toBeUndefined();

    // BUG 1: "Sunday at 1pm" must resolve to an ACTUAL Sunday at 13:00
    // local time — never an unrelated weekday, and (per the documented
    // semantic decision) today if that time hasn't passed yet, else the
    // next Sunday. partySize must be 2 ("my wife").
    const t4 = await handleCustomerMessage(graph, conv, customer, "I wanna come with my wife Sunday at 1pm");
    const earliest = t4.state.knownFields.__mentionedEarliest;
    expect(earliest).toBeTruthy();
    const resolvedDate = new Date(earliest);
    expect(resolvedDate.getUTCDay()).toBe(0); // Sunday, in UTC-day terms (America/New_York never crosses a UTC day boundary by more than a few hours from local midnight)
    // 1pm America/New_York is 17:00 UTC (EDT) or 18:00 UTC (EST) — never a
    // wildly different hour caused by an unrelated weekday computation.
    expect([17, 18]).toContain(resolvedDate.getUTCHours());
    expect(t4.state.knownFields.__mentionedPartySize).toBe("2");

    // BUG 3: "My name is Inon and my phone number is 0558832177" — real
    // values, never sentinel strings, and correctly attributed even
    // though phone is ALSO present in the same message.
    const t5 = await handleCustomerMessage(
      graph,
      conv,
      customer,
      "My name is Inon and my phone number is 0558832177"
    );
    expect(t5.state.knownFields.name).toBe("Inon");
    expect(t5.state.knownFields.phone).toBe("0558832177");
    expect(t5.state.knownFields.name).not.toBe("null");
    expect(t5.state.knownFields.phone).not.toBe("null");

    // Availability was checked for the requested local window, and the
    // response never claims a future check for a tool that already ran.
    expect(t5.turn.selectedAction?.name).toBe("checkAvailability");
    expect(t5.turn.toolResult?.ok).toBe(true);
    const lowerResponse = t5.response.toLowerCase();
    for (const phrase of ["i'll check", "i will check", "get back to you shortly", "will get back to you"]) {
      expect(lowerResponse).not.toContain(phrase);
    }

    // BUG 2: any offered slot must be phrased in America/New_York local
    // time — the response facts the runtime computed are ground truth.
    if (t5.turn.responseFacts?.availableSlots && t5.turn.responseFacts.availableSlots.length > 0) {
      expect(t5.turn.responseFacts.timezone).toBe("America/New_York");
      const slot = t5.turn.responseFacts.availableSlots[0];
      // The response text must reference the LOCAL hour, not the raw UTC one.
      expect(t5.response).toContain(slot.localTime.replace(/^0/, ""));
    }
  });
});
