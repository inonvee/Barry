import { describe, expect, it } from "vitest";
import { composeDeterministic } from "@/lib/reasoner/deterministic-compose";
import { COMPOSE_SYSTEM_PROMPT, buildComposeSummary } from "@/lib/reasoner/openai-reasoner";
import { formatLocalDateTime } from "@/lib/scheduling/resolver";
import type { ComposeResponseInput } from "@/lib/reasoner/types";

/**
 * Live Bug 2 (LIVE Phase 1.5 Bug Fix Mission): a slot at
 * 2026-09-30T17:00:00.000Z (1:00 PM America/New_York) was told to the
 * customer as "5 PM" — composeResponse interpreted the raw UTC ISO string
 * with the server's own runtime timezone instead of the business's.
 * Structural fix: composeResponse never touches a raw ISO timestamp
 * itself anymore; the runtime computes business-timezone-local display
 * facts (`formatLocalDateTime`) BEFORE calling it, and composeDeterministic
 * (also OpenAIReasoner's failure-fallback) only ever renders those.
 *
 * Live Bug 4: after checkAvailability had ALREADY returned slots, BARRY
 * replied "I'll check availability... and get back to you shortly" — a
 * misleading future-tense claim about something already done.
 */
describe("Response grounding: no UTC-as-local leaks, no future-tense claims after a tool already ran", () => {
  it('ask_slot_confirm renders in the business timezone (17:00Z -> 1:00 PM America/New_York, EDT)', () => {
    const iso = "2026-09-30T17:00:00.000Z";
    const display = formatLocalDateTime(iso, "America/New_York");
    const input: ComposeResponseInput = {
      outcome: { kind: "ask_slot_confirm", offeredStart: iso, stage: "scheduling" },
      scheduling: { offeredSlot: display },
    };

    const response = composeDeterministic(input);

    expect(response).toContain("1:00 PM");
    expect(response).not.toContain("5:00 PM");
    expect(response).not.toContain("17:00");
  });

  it("ask_slot_confirm renders correctly across the DST boundary too (winter, EST)", () => {
    const iso = "2026-02-01T18:00:00.000Z"; // 1pm EST
    const display = formatLocalDateTime(iso, "America/New_York");
    const input: ComposeResponseInput = {
      outcome: { kind: "ask_slot_confirm", offeredStart: iso, stage: "scheduling" },
      scheduling: { offeredSlot: display },
    };

    expect(composeDeterministic(input)).toContain("1:00 PM");
  });

  it("checkAvailability's success reply renders the first slot in local time, never the raw UTC hour", () => {
    const iso = "2026-09-30T17:00:00.000Z";
    const display = formatLocalDateTime(iso, "America/New_York");
    const input: ComposeResponseInput = {
      outcome: {
        kind: "action",
        action: { name: "checkAvailability", input: {} },
        stage: "scheduling",
      },
      toolResult: { ok: true, output: { slots: [{ resourceId: "r1", start: iso, end: iso }] } },
      scheduling: { availableSlots: [display] },
    };

    const response = composeDeterministic(input);

    expect(response).toContain("1:00 PM");
    expect(response).not.toContain("5:00 PM");
  });

  it("no deterministic response for a successful action ever claims a future check", () => {
    const iso = "2026-09-30T17:00:00.000Z";
    const display = formatLocalDateTime(iso, "America/New_York");
    const input: ComposeResponseInput = {
      outcome: {
        kind: "action",
        action: { name: "checkAvailability", input: {} },
        stage: "scheduling",
      },
      toolResult: { ok: true, output: { slots: [{ resourceId: "r1", start: iso, end: iso }] } },
      scheduling: { availableSlots: [display] },
    };

    const response = composeDeterministic(input).toLowerCase();

    for (const phrase of ["i'll check", "i will check", "get back to you shortly", "will get back to you"]) {
      expect(response).not.toContain(phrase);
    }
  });

  it("the LLM compose system prompt explicitly forbids future-tense claims once a tool has already run", () => {
    expect(COMPOSE_SYSTEM_PROMPT).toMatch(/already run|already happened|ALREADY RUN/i);
    expect(COMPOSE_SYSTEM_PROMPT).toMatch(/forbidden/i);
  });

  it("the LLM compose system prompt requires using pre-computed local display facts verbatim", () => {
    expect(COMPOSE_SYSTEM_PROMPT).toMatch(/localDate/);
    expect(COMPOSE_SYSTEM_PROMPT).toMatch(/localTime/);
    expect(COMPOSE_SYSTEM_PROMPT).toMatch(/never compute|never.*convert/i);
  });

  it("Hebrew compose input exposes only 24-hour customer-facing display facts, never both 12-hour and 24-hour time fields", () => {
    const input: ComposeResponseInput = {
      outcome: {
        kind: "action",
        action: { name: "checkAvailability", input: {} },
        stage: "scheduling",
      },
      toolResult: { ok: true, output: { slots: [] } },
      scheduling: {
        availableSlots: [
          { localDate: "June 15, 2026", localTime: "09:00", timeZone: "America/New_York" },
          { localDate: "June 15, 2026", localTime: "10:00", timeZone: "America/New_York" },
        ],
      },
    };

    const summary = buildComposeSummary(
      { businessTone: "warm", lastCustomerMessage: "יש שעות פנויות?" },
      input
    );

    expect(summary.scheduling).toEqual(input.scheduling);
    expect(JSON.stringify(summary.scheduling)).toContain("09:00");
    expect(JSON.stringify(summary.scheduling)).not.toMatch(/AM|PM|localTime24/);
  });

  it("English compose input still exposes normal 12-hour customer-facing display facts", () => {
    const input: ComposeResponseInput = {
      outcome: {
        kind: "action",
        action: { name: "checkAvailability", input: {} },
        stage: "scheduling",
      },
      toolResult: { ok: true, output: { slots: [] } },
      scheduling: {
        availableSlots: [
          { localDate: "June 15, 2026", localTime: "9:00 AM", timeZone: "America/New_York" },
        ],
      },
    };

    const summary = buildComposeSummary(
      { businessTone: "warm", lastCustomerMessage: "Any times available?" },
      input
    );

    expect(JSON.stringify(summary.scheduling)).toContain("9:00 AM");
    expect(JSON.stringify(summary.scheduling)).not.toContain("localTime24");
  });

  it("compose summary for availability never contains raw UTC scheduling timestamps", () => {
    const input: ComposeResponseInput = {
      outcome: {
        kind: "action",
        action: {
          name: "checkAvailability",
          input: { earliest: "2026-06-15T13:00:00.000Z", latest: "2026-06-15T16:00:00.000Z" },
        },
        stage: "scheduling",
      },
      toolResult: {
        ok: true,
        output: {
          slots: [
            {
              resourceId: "therapist-1",
              start: "2026-06-15T13:00:00.000Z",
              end: "2026-06-15T14:00:00.000Z",
            },
          ],
        },
      },
      scheduling: {
        availableSlots: [
          { localDate: "June 15, 2026", localTime: "09:00", timeZone: "America/New_York" },
        ],
      },
    };

    const summary = buildComposeSummary(
      { businessTone: "warm", lastCustomerMessage: "יש שעות פנויות?" },
      input
    );

    expect(JSON.stringify(summary)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it("compose summary for booking never contains raw UTC scheduling timestamps", () => {
    const input: ComposeResponseInput = {
      outcome: {
        kind: "action",
        action: {
          name: "createBooking",
          input: { start: "2026-06-15T13:00:00.000Z", end: "2026-06-15T14:00:00.000Z" },
        },
        stage: "confirmation",
      },
      toolResult: {
        ok: true,
        output: {
          bookingId: "booking-1",
          start: "2026-06-15T13:00:00.000Z",
          end: "2026-06-15T14:00:00.000Z",
        },
      },
      scheduling: {
        offeredSlot: { localDate: "June 15, 2026", localTime: "9:00 AM", timeZone: "America/New_York" },
      },
    };

    const summary = buildComposeSummary(
      { businessTone: "warm", lastCustomerMessage: "Yes that works" },
      input
    );

    expect(JSON.stringify(summary)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });
});
