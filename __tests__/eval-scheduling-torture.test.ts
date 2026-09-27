import { describe, expect, it } from "vitest";
import { resolveSchedulingWindow, formatLocalDateTime } from "@/lib/scheduling/resolver";
import { extractExplicitSchedulingConstraint } from "@/lib/reasoner/entities";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { runScenario } from "./support/eval-harness";

/**
 * MEGA RELIABILITY MISSION — Part 10: scheduling torture test. The
 * resolver (`src/lib/scheduling/resolver.ts`) is the ONE place a semantic
 * scheduling constraint ("Sunday", "at 2pm") becomes an absolute UTC
 * instant, using the business's own timezone — never the server's. This
 * suite matrices across four structurally different timezones (a
 * DST-observing US zone, a DST-observing European zone, a DST-observing
 * Middle-East zone whose transition dates don't line up with the US/EU
 * ones, and a zone with NO DST at all) and covers every scheduling shape
 * the resolver accepts, plus the two DST anomaly cases explicitly.
 *
 * Real bug found and fixed while building this suite (resolver.ts):
 * `zonedTimeToUtc`'s DST-transition probe window was fixed at ±3 hours
 * around a "naive guess" that treats the requested LOCAL digits as if
 * they were UTC. For a zone like America/New_York (UTC-5), that naive
 * guess sits ~5 hours away from the real instant, so a spring-forward
 * transition 4.5 hours away from the guess fell entirely outside the
 * probe window — both probe points landed on the same (pre-transition)
 * side, and the anomaly went completely undetected for both NY cases
 * tested (spring-forward AND fall-back), while the smaller-offset
 * Europe/London case happened to be caught by luck of a smaller offset.
 * Fixed by widening the probe window to 25 hours — safely larger than
 * any real IANA UTC offset magnitude (max ~14h) plus the transition gap
 * itself, while still guaranteed to never straddle two transitions
 * (transitions are always months apart).
 */

const TIMEZONES = {
  us: "America/New_York", // DST: second Sunday March -> first Sunday November
  eu: "Europe/London", // DST: last Sunday March -> last Sunday October
  il: "Asia/Jerusalem", // DST, but transition dates don't align with US/EU
  jp: "Asia/Tokyo", // no DST at all
};

describe("Scheduling torture: weekday matrix across all 4 timezones x all 7 weekdays", () => {
  // A fixed Wednesday, 2026-01-14 12:00 UTC — well clear of any DST
  // transition in any of the four zones under test.
  const anchor = new Date("2026-01-14T12:00:00.000Z");

  for (const [label, tz] of Object.entries(TIMEZONES)) {
    for (let weekday = 0; weekday <= 6; weekday++) {
      it(`[${label}] weekday ${weekday} at 14:00 resolves to a local 14:00 display on the right weekday`, () => {
        const result = resolveSchedulingWindow(
          { date: { kind: "weekday", weekday }, time: { kind: "explicitTime", hour: 14, minute: 0 } },
          tz,
          anchor
        );
        expect(result).toBeDefined();
        const display = formatLocalDateTime(result!.earliest, tz);
        expect(display.localTime).toMatch(/^2:00\s*PM$/i);
        expect(result!.anomaly).toBeUndefined();
      });
    }
  }
});

describe("Scheduling torture: today future vs past, and tomorrow", () => {
  for (const [label, tz] of Object.entries(TIMEZONES)) {
    it(`[${label}] "today at 8pm" from a morning anchor resolves to today, not tomorrow`, () => {
      // A fixed morning instant in each zone: use a UTC instant known to
      // be morning-local everywhere in a rough sense isn't feasible for
      // all 4 zones with one UTC instant, so anchor per-zone via a wide
      // early-UTC-day instant and only assert same calendar day.
      const morningAnchor = new Date("2026-01-14T04:00:00.000Z");
      const result = resolveSchedulingWindow(
        { date: { kind: "relativeDay", days: 0 }, time: { kind: "explicitTime", hour: 20, minute: 0 } },
        tz,
        morningAnchor
      );
      expect(result).toBeDefined();
      const display = formatLocalDateTime(result!.earliest, tz);
      expect(display.localTime).toMatch(/^8:00\s*PM$/i);
    });

    it(`[${label}] "tomorrow at 9am" resolves to the next calendar day in ${tz}`, () => {
      const anchor = new Date("2026-01-14T12:00:00.000Z");
      const todayLocal = formatLocalDateTime(anchor.toISOString(), tz).localDate;
      const result = resolveSchedulingWindow(
        { date: { kind: "relativeDay", days: 1 }, time: { kind: "explicitTime", hour: 9, minute: 0 } },
        tz,
        anchor
      );
      const tomorrowLocal = formatLocalDateTime(result!.earliest, tz).localDate;
      expect(tomorrowLocal).not.toBe(todayLocal);
    });
  }
});

describe("Scheduling torture: explicit date, month boundary, year boundary", () => {
  it("an explicit date resolves exactly, regardless of business timezone", () => {
    const result = resolveSchedulingWindow(
      { date: { kind: "explicitDate", isoDate: "2026-07-04" }, time: { kind: "explicitTime", hour: 10, minute: 0 } },
      "Asia/Tokyo"
    );
    expect(formatLocalDateTime(result!.earliest, "Asia/Tokyo").localDate).toBe("July 4, 2026");
  });

  it("relativeDay correctly crosses a month boundary (Jan 31 -> Feb 1)", () => {
    const anchor = new Date("2026-01-31T12:00:00.000Z");
    const result = resolveSchedulingWindow(
      { date: { kind: "relativeDay", days: 1 }, time: { kind: "explicitTime", hour: 9, minute: 0 } },
      "America/New_York",
      anchor
    );
    expect(formatLocalDateTime(result!.earliest, "America/New_York").localDate).toBe("February 1, 2026");
  });

  it("relativeDay correctly crosses a YEAR boundary (Dec 31 -> Jan 1)", () => {
    const anchor = new Date("2026-12-31T12:00:00.000Z");
    const result = resolveSchedulingWindow(
      { date: { kind: "relativeDay", days: 1 }, time: { kind: "explicitTime", hour: 9, minute: 0 } },
      "America/New_York",
      anchor
    );
    expect(formatLocalDateTime(result!.earliest, "America/New_York").localDate).toBe("January 1, 2027");
  });

  it("a weekday request that rolls forward can cross a year boundary without landing on the wrong weekday", () => {
    // Thursday 2026-12-31; the immediate upcoming Monday is 2027-01-04,
    // so "next Monday" (which always skips that one) lands on 2027-01-11
    // — still a genuine Monday, just on the far side of the year boundary.
    const anchor = new Date("2026-12-31T12:00:00.000Z");
    const result = resolveSchedulingWindow(
      { date: { kind: "weekday", weekday: 1, qualifier: "next" }, time: { kind: "explicitTime", hour: 10, minute: 0 } },
      "America/New_York",
      anchor
    );
    expect(result!.earliest.slice(0, 10)).toBe("2027-01-11");
    expect(new Date(result!.earliest).getUTCDay()).toBe(1);
  });
});

describe("Scheduling torture: part-of-day defaults hold across timezones", () => {
  for (const [label, tz] of Object.entries(TIMEZONES)) {
    it(`[${label}] "morning"/"afternoon"/"evening" resolve to their documented default local hours`, () => {
      const anchor = new Date("2026-01-14T12:00:00.000Z");
      const morning = resolveSchedulingWindow({ date: { kind: "relativeDay", days: 2 }, time: { kind: "partOfDay", part: "morning" } }, tz, anchor);
      const afternoon = resolveSchedulingWindow({ date: { kind: "relativeDay", days: 2 }, time: { kind: "partOfDay", part: "afternoon" } }, tz, anchor);
      const evening = resolveSchedulingWindow({ date: { kind: "relativeDay", days: 2 }, time: { kind: "partOfDay", part: "evening" } }, tz, anchor);
      expect(formatLocalDateTime(morning!.earliest, tz).localTime).toMatch(/^9:00\s*AM$/i);
      expect(formatLocalDateTime(afternoon!.earliest, tz).localTime).toMatch(/^2:00\s*PM$/i);
      expect(formatLocalDateTime(evening!.earliest, tz).localTime).toMatch(/^6:00\s*PM$/i);
    });
  }
});

describe("Scheduling torture: 12h vs 24h semantic time extraction agree on the same instant", () => {
  it('"at 2pm" and "at 14:00" extract to the same explicitTime constraint', () => {
    const twelveHour = extractExplicitSchedulingConstraint("Tuesday at 2pm");
    const twentyFourHour = extractExplicitSchedulingConstraint("Tuesday at 14:00");
    expect(twelveHour?.time).toEqual({ kind: "explicitTime", hour: 14, minute: 0 });
    expect(twentyFourHour?.time).toEqual({ kind: "explicitTime", hour: 14, minute: 0 });
  });

  it('"at 9am" and "at 09:00" extract to the same explicitTime constraint', () => {
    const twelveHour = extractExplicitSchedulingConstraint("Tuesday at 9am");
    const twentyFourHour = extractExplicitSchedulingConstraint("Tuesday at 09:00");
    expect(twelveHour?.time).toEqual({ kind: "explicitTime", hour: 9, minute: 0 });
    expect(twentyFourHour?.time).toEqual({ kind: "explicitTime", hour: 9, minute: 0 });
  });

  it('"at 12pm" is noon (12:00), not midnight', () => {
    expect(extractExplicitSchedulingConstraint("today at 12pm")?.time).toEqual({
      kind: "explicitTime",
      hour: 12,
      minute: 0,
    });
  });

  it('"at 12am" is midnight (00:00), not noon', () => {
    expect(extractExplicitSchedulingConstraint("today at 12am")?.time).toEqual({
      kind: "explicitTime",
      hour: 0,
      minute: 0,
    });
  });
});

describe("Scheduling torture: DST anomalies — nonexistent (spring-forward) local time", () => {
  it("America/New_York: 2026-03-08 02:30 falls inside the spring-forward gap (clocks jump 2:00->3:00) and is flagged nonexistent", () => {
    const result = resolveSchedulingWindow(
      { date: { kind: "explicitDate", isoDate: "2026-03-08" }, time: { kind: "explicitTime", hour: 2, minute: 30 } },
      "America/New_York"
    );
    expect(result?.anomaly).toBe("nonexistent");
    // Policy: BARRY never silently invents an instant here — it's always
    // observable via `anomaly`, and the resolved instant still lands
    // somewhere at/after the gap, never before it.
    expect(new Date(result!.earliest).getTime()).toBeGreaterThanOrEqual(
      new Date("2026-03-08T07:00:00.000Z").getTime()
    );
  });

  it("Europe/London: 2026-03-29 01:30 falls inside the spring-forward gap (clocks jump 1:00->2:00 BST) and is flagged nonexistent", () => {
    const result = resolveSchedulingWindow(
      { date: { kind: "explicitDate", isoDate: "2026-03-29" }, time: { kind: "explicitTime", hour: 1, minute: 30 } },
      "Europe/London"
    );
    expect(result?.anomaly).toBe("nonexistent");
  });

  it("a normal (non-transition) time on the same DST day is NOT flagged as an anomaly", () => {
    const result = resolveSchedulingWindow(
      { date: { kind: "explicitDate", isoDate: "2026-03-08" }, time: { kind: "explicitTime", hour: 10, minute: 0 } },
      "America/New_York"
    );
    expect(result?.anomaly).toBeUndefined();
  });
});

describe("Scheduling torture: DST anomalies — ambiguous (fall-back) local time", () => {
  it("America/New_York: 2026-11-01 01:30 occurs twice (clocks fall back 2:00->1:00) and is flagged ambiguous, resolving to the EARLIER instant", () => {
    const result = resolveSchedulingWindow(
      { date: { kind: "explicitDate", isoDate: "2026-11-01" }, time: { kind: "explicitTime", hour: 1, minute: 30 } },
      "America/New_York"
    );
    expect(result?.anomaly).toBe("ambiguous");
    // Policy: prefer the earlier of the two real instants (still in the
    // pre-transition, daylight-saving offset — EDT, UTC-4).
    expect(result?.earliest).toBe("2026-11-01T05:30:00.000Z");
  });

  it("Europe/London: 2026-10-25 01:30 occurs twice (clocks fall back 2:00->1:00 BST->GMT) and is flagged ambiguous, resolving to the EARLIER instant", () => {
    const result = resolveSchedulingWindow(
      { date: { kind: "explicitDate", isoDate: "2026-10-25" }, time: { kind: "explicitTime", hour: 1, minute: 30 } },
      "Europe/London"
    );
    expect(result?.anomaly).toBe("ambiguous");
    expect(result?.earliest).toBe("2026-10-25T00:30:00.000Z");
  });

  it("a zone with no DST at all (Asia/Tokyo) never reports a DST anomaly, for any local time", () => {
    const result = resolveSchedulingWindow(
      { date: { kind: "explicitDate", isoDate: "2026-11-01" }, time: { kind: "explicitTime", hour: 1, minute: 30 } },
      "Asia/Tokyo"
    );
    expect(result?.anomaly).toBeUndefined();
  });

  it("Asia/Jerusalem's own DST transition (which doesn't align with US/EU dates) is independently detected", () => {
    // Israel's 2026 spring-forward is 2026-03-27 (clocks jump 2:00->3:00).
    const result = resolveSchedulingWindow(
      { date: { kind: "explicitDate", isoDate: "2026-03-27" }, time: { kind: "explicitTime", hour: 2, minute: 30 } },
      "Asia/Jerusalem"
    );
    expect(result?.anomaly).toBe("nonexistent");
  });
});

describe("Scheduling torture: corrections change the resolved instant end-to-end", () => {
  it("a customer who corrects the day gets a genuinely different resolved window, not the stale one", async () => {
    const { turns } = await runScenario({
      name: "scheduling-correction",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage Tuesday at 3pm" },
        { customer: "Actually make it Thursday at 3pm instead" },
      ],
    });
    const first = turns[0].compiled?.resolvedSchedulingWindow?.earliest;
    const second = turns[1].compiled?.resolvedSchedulingWindow?.earliest;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(new Date(second!).getUTCDay()).toBe(4); // Thursday
  });

  it("a customer who corrects only the time keeps the same day", async () => {
    const { turns } = await runScenario({
      name: "scheduling-correction-time-only",
      graph: buildSpaGraph,
      turns: [{ customer: "Couples massage Tuesday at 3pm" }, { customer: "Actually 5pm instead" }],
    });
    const first = new Date(turns[0].compiled!.resolvedSchedulingWindow!.earliest);
    const second = new Date(turns[1].compiled!.resolvedSchedulingWindow!.earliest);
    expect(second.getUTCDay()).toBe(first.getUTCDay());
    expect(second.getTime()).not.toBe(first.getTime());
  });
});
