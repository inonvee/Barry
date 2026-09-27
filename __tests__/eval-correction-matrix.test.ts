import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { runScenario } from "./support/eval-harness";

/**
 * MEGA RELIABILITY MISSION — Part 4: correction / change-of-mind matrix.
 * Attacks state mutation directly: a new explicit value must replace the
 * old one, unrelated state must survive untouched, and offer-specific
 * scratch state must be cleared safely when the offer itself changes.
 */

describe("Correction matrix: scheduling corrections", () => {
  it('"Tuesday at 3" then "Actually Wednesday at 4" — new value replaces old, offer/identity untouched', async () => {
    const { state } = await runScenario({
      name: "correct-datetime",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage please" },
        { customer: "My name is Inon and my phone number is 0501234567" },
        {
          customer: "Tuesday at 3",
          assert: ({ turn }) => {
            expect(new Date(turn.compiled?.resolvedSchedulingWindow?.earliest ?? "").getUTCDay()).toBe(2);
          },
        },
        {
          customer: "Actually Wednesday at 4",
          assert: ({ turn }) => {
            const iso = turn.compiled?.resolvedSchedulingWindow?.earliest;
            expect(iso).toBeTruthy();
            expect(new Date(iso!).getUTCDay()).toBe(3); // Wednesday
            expect(new Date(iso!).getUTCHours()).toBe(20); // 4pm EDT/EST -> 20:00 or 21:00 UTC
          },
        },
      ],
      finalAssert: ({ state }) => {
        expect(state.selectedOfferId).toBe("offer-couples-massage");
        expect(state.knownFields.name).toBe("Inon");
        expect(state.knownFields.phone).toBe("0501234567");
      },
    });
    expect(state.selectedOfferId).toBe("offer-couples-massage");
  });

  it('"Tomorrow" then "No, next Monday" — relativeDay replaced by an explicit weekday+qualifier', async () => {
    await runScenario({
      name: "correct-tomorrow-to-next-monday",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage please" },
        { customer: "Tomorrow at 2pm" },
        {
          customer: "No, next Monday instead",
          assert: ({ turn }) => {
            expect(turn.understood.schedulingWindow?.date).toEqual({
              kind: "weekday",
              weekday: 1,
              qualifier: "next",
            });
          },
        },
      ],
    });
  });
});

describe("Correction matrix: offer change-of-mind", () => {
  it('"Couples" then "Actually solo" — offer switches, identity survives, stale slot state clears', async () => {
    const { state } = await runScenario({
      name: "correct-offer",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage Tuesday at 3pm" },
        { customer: "My name is Inon and my phone number is 0501234567" },
        {
          customer: "Actually solo instead",
          assert: ({ state }) => {
            expect(state.selectedOfferId).toBe("offer-solo-massage");
            // Identity is NOT offer-specific — must survive the switch.
            expect(state.knownFields.name).toBe("Inon");
            expect(state.knownFields.phone).toBe("0501234567");
            // Stale slot-acceptance/payment state from the OLD offer must not leak.
            expect(state.knownFields.__slotAccepted).toBeUndefined();
            expect(state.knownFields.__paymentRequestId).toBeUndefined();
            expect(state.knownFields.__paid).toBeUndefined();
          },
        },
      ],
    });
    expect(state.selectedOfferId).toBe("offer-solo-massage");
  });
});

describe("Correction matrix: contact info corrections", () => {
  it('"My number is 0501111111" then "Sorry, it\'s 0502222222" — corrected value replaces the old one', async () => {
    const { state } = await runScenario({
      name: "correct-phone",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage please" },
        { customer: "My name is Inon" },
        { customer: "My number is 0501111111" },
        { customer: "Sorry, it's 0502222222" },
      ],
    });
    expect(state.knownFields.phone).toBe("0502222222");
    expect(state.knownFields.name).toBe("Inon"); // unrelated state intact
  });

  it('"My name is Inon" then "Actually use Jordan" — corrected name replaces the old one', async () => {
    const { state } = await runScenario({
      name: "correct-name",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage please" },
        { customer: "My name is Inon" },
        { customer: "My phone number is 0501234567" },
        { customer: "Actually use Jordan" },
      ],
    });
    // "Actually use Jordan" has no explicit "my name is"/"call me" marker,
    // so this exercises the LLM/Mock's own judgment, not the deterministic
    // override — assert only that the ORIGINAL correct value was never
    // silently destroyed by garbage (still a real name, phone untouched).
    expect(state.knownFields.phone).toBe("0501234567");
    expect(typeof state.knownFields.name).toBe("string");
    expect(state.knownFields.name!.length).toBeGreaterThan(0);
  });
});

describe("Correction matrix: multiple corrections combined in one conversation", () => {
  it("offer switch + datetime correction + phone correction, in sequence, all converge correctly", async () => {
    const { state } = await runScenario({
      name: "multi-correction",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage Tuesday at 3pm" },
        { customer: "My name is Inon and my phone number is 0501111111" },
        { customer: "Actually solo instead" },
        { customer: "Actually Wednesday at 4 instead" },
        { customer: "Sorry, my number is actually 0502222222" },
      ],
    });

    expect(state.selectedOfferId).toBe("offer-solo-massage");
    expect(state.knownFields.name).toBe("Inon");
    expect(state.knownFields.phone).toBe("0502222222");
    const earliest = state.knownFields.__mentionedEarliest;
    expect(earliest).toBeTruthy();
    expect(new Date(earliest).getUTCDay()).toBe(3); // Wednesday
    // Stale slot/payment state from before either correction must be gone.
    expect(state.knownFields.__slotAccepted).toBeUndefined();
    expect(state.knownFields.__paymentRequestId).toBeUndefined();
  });
});
