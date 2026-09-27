import { describe, expect, it } from "vitest";
import { resolveSchedulingWindow } from "@/lib/scheduling/resolver";

/**
 * The resolver is BARRY's own deterministic code, not the model's — an
 * LLM only ever describes scheduling semantically ("Sunday", "at 2pm").
 * These tests fix `now` so results are reproducible, and use two
 * different business timezones (never a hardcoded/fixture-specific one)
 * to prove the business's own `business.timezone` actually drives the
 * result, including across a real DST boundary.
 */
describe("scheduling resolver", () => {
  // A fixed Wednesday, 2026-01-14 12:00 UTC, well before US DST starts.
  const wednesdayWinter = new Date("2026-01-14T12:00:00.000Z");

  it('"Sunday at 2pm" resolves in the business timezone, not the server\'s', () => {
    const constraint = {
      date: { kind: "weekday" as const, weekday: 0 },
      time: { kind: "explicitTime" as const, hour: 14, minute: 0 },
    };

    const inNewYork = resolveSchedulingWindow(constraint, "America/New_York", wednesdayWinter);
    const inTokyo = resolveSchedulingWindow(constraint, "Asia/Tokyo", wednesdayWinter);

    expect(inNewYork).toBeDefined();
    expect(inTokyo).toBeDefined();
    // Same semantic request, different business timezones -> different
    // absolute instants (Tokyo has no DST, so it's a clean fixed offset:
    // UTC+9, so 14:00 JST = 05:00 UTC on the same calendar day).
    expect(inNewYork!.earliest).not.toBe(inTokyo!.earliest);
    expect(inTokyo!.earliest).toBe("2026-01-18T05:00:00.000Z");
  });

  it('"this Sunday at 2pm" is the next upcoming Sunday from a Wednesday', () => {
    const result = resolveSchedulingWindow(
      { date: { kind: "weekday", weekday: 0, qualifier: "this" }, time: { kind: "explicitTime", hour: 14, minute: 0 } },
      "America/New_York",
      wednesdayWinter
    );
    // Jan 14 2026 is a Wednesday; the next Sunday is Jan 18. EST is UTC-5 in January.
    expect(result?.earliest).toBe("2026-01-18T19:00:00.000Z");
  });

  it('"next Monday" skips past the immediate upcoming Monday to the one after', () => {
    const plainMonday = resolveSchedulingWindow(
      { date: { kind: "weekday", weekday: 1 } },
      "America/New_York",
      wednesdayWinter
    );
    const nextMonday = resolveSchedulingWindow(
      { date: { kind: "weekday", weekday: 1, qualifier: "next" } },
      "America/New_York",
      wednesdayWinter
    );
    expect(plainMonday?.earliest.slice(0, 10)).toBe("2026-01-19"); // the coming Monday
    expect(nextMonday?.earliest.slice(0, 10)).toBe("2026-01-26"); // a week later
  });

  it('"tomorrow at 3" resolves to the next calendar day in the business timezone', () => {
    const result = resolveSchedulingWindow(
      { date: { kind: "relativeDay", days: 1 }, time: { kind: "explicitTime", hour: 15, minute: 0 } },
      "America/New_York",
      wednesdayWinter
    );
    expect(result?.earliest).toBe("2026-01-15T20:00:00.000Z"); // Jan 15, 15:00 EST = 20:00 UTC
  });

  it('"Monday afternoon" uses the part-of-day default hour', () => {
    const result = resolveSchedulingWindow(
      { date: { kind: "weekday", weekday: 1 }, time: { kind: "partOfDay", part: "afternoon" } },
      "America/New_York",
      wednesdayWinter
    );
    expect(result?.earliest.slice(11, 16)).toBe("19:00"); // 14:00 EST -> 19:00 UTC
  });

  it("correctly crosses a DST boundary using the business timezone (no hardcoded offset)", () => {
    // US DST begins 2026-03-08. Jan 14 (before) is EST (UTC-5); a date in
    // late March (after) is EDT (UTC-4) — same local 2pm, different UTC hour.
    const beforeDst = resolveSchedulingWindow(
      { date: { kind: "explicitDate", isoDate: "2026-01-20" }, time: { kind: "explicitTime", hour: 14, minute: 0 } },
      "America/New_York"
    );
    const afterDst = resolveSchedulingWindow(
      { date: { kind: "explicitDate", isoDate: "2026-03-20" }, time: { kind: "explicitTime", hour: 14, minute: 0 } },
      "America/New_York"
    );
    expect(beforeDst?.earliest.slice(11, 16)).toBe("19:00"); // UTC-5
    expect(afterDst?.earliest.slice(11, 16)).toBe("18:00"); // UTC-4
  });

  it("returns undefined when nothing was mentioned (no date, no time)", () => {
    expect(resolveSchedulingWindow({}, "America/New_York", wednesdayWinter)).toBeUndefined();
  });

  it("defaults to a reasonable business-hours time when only a date was mentioned", () => {
    const result = resolveSchedulingWindow(
      { date: { kind: "relativeDay", days: 0 } },
      "America/New_York",
      wednesdayWinter
    );
    expect(result?.earliest.slice(11, 16)).toBe("14:00"); // 09:00 EST -> 14:00 UTC
  });
});
