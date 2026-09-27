import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { callTool } from "@/lib/tools";
import { formatLocalDateTime } from "@/lib/scheduling/resolver";
import { sanitizeOutcomeForCompose } from "@/lib/reasoner/openai-reasoner";
import { runScenario, assertDoesNotAskFor } from "./support/eval-harness";

/**
 * MEGA RELIABILITY MISSION — Part 17: response grounding. A reply must
 * never claim to still be doing something a tool already finished, never
 * ask for more than exactly what's missing, never infer facts (a name,
 * a phone number) that were never actually given, and never leak an
 * internal implementation detail (a raw UTC timestamp, a Postgres error,
 * a Zod validation message, a scratch key) to the customer.
 *
 * checkGlobalInvariants (eval-harness.ts) already asserts on EVERY turn
 * of EVERY scenario in this whole suite that the response never contains
 * a raw ISO timestamp — this file adds the remaining Part 17-specific
 * checks not already covered elsewhere.
 *
 * Two real bugs found and fixed while building this suite:
 *
 * 1. registry.ts's `callTool` returned `err.message` as `toolResult.
 *    error` completely unsanitized — and deterministic-compose (and the
 *    LLM reasoner's prompt) interpolate that string DIRECTLY into the
 *    customer-facing reply ("Sorry — I ran into an issue
 *    (${toolResult.error})"). Several backend error paths embed raw
 *    internals: `supabase-backend.ts`'s "Failed to create booking: <raw
 *    Postgres error>", a Zod schema-validation message ("Invalid input
 *    for X: ..."), "Unknown tool: X". Fixed with a curated allowlist of
 *    customer-safe error strings (the ones tools deliberately throw FOR
 *    the customer, e.g. "Slot no longer available") — anything else is
 *    replaced with a generic safe message, with the real error still
 *    logged server-side via console.error for debugging.
 *
 * 2. openai-reasoner.ts's composeResponse() handed the LLM the FULL
 *    CompileOutcome as JSON, including `.debug.resolvedSchedulingWindow`
 *    (a raw UTC ISO instant) and, for any "action" outcome,
 *    `action.input` (which for checkAvailability/createBooking directly
 *    contains raw UTC `earliest`/`latest` strings) — relying ENTIRELY on
 *    a prompt instruction ("never use a raw ISO timestamp") to prevent
 *    leakage, with the actual raw data still sitting right there in the
 *    same JSON blob as the ONE correct source (`scheduling`'s localDate/
 *    localTime/localTime24). Added `sanitizeOutcomeForCompose()`,
 *    stripping `.debug` and any raw-ISO-bearing field before the JSON
 *    ever reaches the model — the same "never trust a raw timestamp"
 *    principle this architecture already applies everywhere else,
 *    applied structurally instead of by instruction alone.
 *
 * Also fixed (same commit, same file's docstring): Hebrew replies had no
 * way to use 24-hour time — `formatLocalDateTime` only ever computed a
 * 12-hour "2:00 PM"-style string. Added `localTime24` alongside it, and
 * updated the compose prompt to pick whichever matches the reply's
 * actual language (never the business's fixed locale, since a Hebrew
 * customer can message an English-locale business and vice versa).
 */
describe("Response grounding: never claims to still be checking something a tool already finished", () => {
  it('checkAvailability that already ran never produces "I\'ll check"/"get back to you" phrasing', async () => {
    const { turns } = await runScenario({
      name: "grounding-no-future-tense",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage Tuesday at 3pm" }],
    });
    const response = turns[0].response.toLowerCase();
    expect(response).not.toMatch(/i'?ll check|i will check|get back to you|look into it/);
  });
});

describe("Response grounding: singular phrasing for a single available slot", () => {
  it('never says "choose from the following slots" (plural) when only one slot is available', async () => {
    const { turns } = await runScenario({
      name: "grounding-singular-slot",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage Tuesday at 3pm" }],
    });
    const response = turns[0].response.toLowerCase();
    expect(response).not.toMatch(/choose from the following|following slots|these slots/);
  });
});

describe("Response grounding: asks for exactly what missingFields names, nothing more", () => {
  it("never pluralizes a single missing field into multiple, and only asks for the actually-missing ones", async () => {
    const { turns } = await runScenario({
      name: "grounding-exact-missing-fields",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage Tuesday at 3pm" },
        {
          customer: "My name is Inon",
          assert: ({ response }) => {
            // Only phone is still missing — must ask for phone, never
            // re-ask for name, never say "names" (plural).
            expect(response.toLowerCase()).toMatch(/phone/);
            expect(response.toLowerCase()).not.toMatch(/\bnames\b/);
            assertDoesNotAskFor(response, "your name");
          },
        },
      ],
    });
    expect(turns[1].stateAfter.stage).not.toBe("closed");
  });
});

describe("Response grounding: never infers participant names/phones from partySize", () => {
  it('partySize=2 (from "with my wife") never causes BARRY to ask for or assume a second name/phone', async () => {
    const { turns } = await runScenario({
      name: "grounding-no-inferred-second-contact",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage with my wife Tuesday at 3pm" }],
    });
    const response = turns[0].response.toLowerCase();
    expect(response).not.toMatch(/her name|their name|second name|wife'?s (name|phone)|partner'?s (name|phone)/);
  });
});

describe("Response grounding: never exposes internal implementation details", () => {
  it("an internal Zod/backend error is replaced with a generic customer-safe message, never the raw error", async () => {
    const graph = buildSpaGraph();
    const ctx = { graph, conversationId: "grounding-ctx", customerId: "grounding-cust" };

    // Deliberately malformed input — a real Zod validation failure, the
    // exact class of internal detail that must never reach a customer.
    const result = await callTool("checkAvailability", { offerId: 123, notARealField: true }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toMatch(/zod|expected string|invalid_type|invalid input for/i);
      expect(result.error).toMatch(/something went wrong|try that again/i);
    }
  });

  it("an unknown tool name never leaks the raw registry-lookup message shape", async () => {
    const graph = buildSpaGraph();
    const ctx = { graph, conversationId: "grounding-ctx-2", customerId: "grounding-cust-2" };
    const result = await callTool("definitelyNotARealTool", {}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toMatch(/unknown tool/i);
    }
  });

  it("a legitimately customer-facing tool error (e.g. a booking conflict) still passes through unchanged", async () => {
    const graph = buildSpaGraph();
    const ctx = { graph, conversationId: "grounding-ctx-3", customerId: "grounding-cust-3" };
    // First booking succeeds...
    const first = await callTool(
      "createBooking",
      { offerId: "offer-couples-massage", resourceId: "therapist-1", start: "2031-01-01T09:00:00.000Z", end: "2031-01-01T10:00:00.000Z", partySize: 1 },
      ctx
    );
    expect(first.ok).toBe(true);
    // ...a second booking for the exact same resource+slot correctly
    // surfaces the CUSTOMER-MEANINGFUL "Slot no longer available", not a
    // generic fallback — this message IS meant to reach them.
    const second = await callTool(
      "createBooking",
      { offerId: "offer-couples-massage", resourceId: "therapist-1", start: "2031-01-01T09:00:00.000Z", end: "2031-01-01T10:00:00.000Z", partySize: 1 },
      ctx
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("Slot no longer available");
  });
});

describe("Response grounding: the LLM compose path never even receives raw internal data", () => {
  it("sanitizeOutcomeForCompose strips the raw UTC resolvedSchedulingWindow debug info", () => {
    const outcome = {
      kind: "action" as const,
      action: { name: "checkAvailability", input: { offerId: "x", earliest: "2026-01-01T00:00:00.000Z", latest: "2026-01-01T03:00:00.000Z" } },
      stage: "scheduling" as const,
      debug: {
        appliedCustomerInfo: {},
        resolvedSchedulingWindow: { earliest: "2026-01-01T00:00:00.000Z", latest: "2026-01-01T03:00:00.000Z" },
      },
    };
    const sanitized = JSON.stringify(sanitizeOutcomeForCompose(outcome));
    expect(sanitized).not.toMatch(/2026-01-01T00:00:00/);
    expect(sanitized).not.toMatch(/resolvedSchedulingWindow/);
  });

  it("sanitizeOutcomeForCompose strips raw UTC action.input for an action outcome", () => {
    const outcome = {
      kind: "action" as const,
      action: { name: "createBooking", input: { start: "2026-03-08T15:00:00.000Z", end: "2026-03-08T16:00:00.000Z" } },
      stage: "confirmation" as const,
    };
    const sanitized = JSON.stringify(sanitizeOutcomeForCompose(outcome));
    expect(sanitized).not.toMatch(/2026-03-08T15:00:00/);
    // The action NAME is still needed for phrasing.
    expect(sanitized).toMatch(/createBooking/);
  });

  it("sanitizeOutcomeForCompose strips the raw offeredStart for ask_slot_confirm", () => {
    const outcome = { kind: "ask_slot_confirm" as const, offeredStart: "2026-01-01T15:00:00.000Z", stage: "scheduling" as const };
    const sanitized = JSON.stringify(sanitizeOutcomeForCompose(outcome));
    expect(sanitized).not.toMatch(/2026-01-01T15:00:00/);
  });
});

describe("Response grounding: Hebrew time display prefers 24-hour format", () => {
  it("formatLocalDateTime computes BOTH a 12-hour and a 24-hour rendering of the same instant", () => {
    const display = formatLocalDateTime("2026-06-15T18:00:00.000Z", "America/New_York");
    expect(display.localTime).toMatch(/^2:00\s*PM$/i);
    expect(display.localTime24).toBe("14:00");
  });

  it("a 24-hour rendering correctly handles a morning hour with no am/pm ambiguity", () => {
    const display = formatLocalDateTime("2026-06-15T13:00:00.000Z", "America/New_York");
    expect(display.localTime).toMatch(/^9:00\s*AM$/i);
    expect(display.localTime24).toBe("09:00");
  });

  it("Hebrew availability response facts expose 24-hour display times only", async () => {
    const { turns } = await runScenario({
      name: "grounding-hebrew-24h-compose-facts",
      graph: buildSpaGraph,
      turns: [{ customer: "זוגי ביום חמישי בשעה אחד השם שלי ינון 0558832177" }],
    });

    const slots = turns[0].responseFacts?.availableSlots ?? [];
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].localTime).toMatch(/^\d{2}:\d{2}$/);
    expect(JSON.stringify(turns[0].responseFacts)).not.toMatch(/AM|PM|localTime24/);
  });

  it("English availability response facts keep 12-hour display times", async () => {
    const { turns } = await runScenario({
      name: "grounding-english-12h-compose-facts",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage Thursday at 1. My name is Inon and my phone number is 0558832177" }],
    });

    const slots = turns[0].responseFacts?.availableSlots ?? [];
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].localTime).toMatch(/\b(AM|PM)\b/);
    expect(JSON.stringify(turns[0].responseFacts)).not.toContain("localTime24");
  });
});
