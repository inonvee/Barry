/**
 * Deterministic, timezone-aware scheduling resolver. This is BARRY's own
 * code, not the model's: an LLM (or the regex-based MockReasoner) is only
 * ever asked to describe scheduling SEMANTICALLY — "Sunday", "at 2pm",
 * "tomorrow" — never to compute a UTC timestamp itself. This module is the
 * one place that turns that semantic description into an absolute instant,
 * using the BUSINESS's timezone (`business.timezone` in the Business
 * Graph), never the server's local time zone or a hardcoded one.
 *
 * No date library dependency: everything here is built on `Intl` (IANA
 * timezone data ships with Node/V8), using the standard "round-trip"
 * technique to convert a local wall-clock time in an arbitrary timezone to
 * a UTC instant, which correctly accounts for DST because
 * `Intl.DateTimeFormat` always reflects the true offset for a given
 * instant.
 */

export type DateSpec =
  | { kind: "explicitDate"; isoDate: string } // "2026-10-05", no time/zone
  | { kind: "relativeDay"; days: number } // "today" = 0, "tomorrow" = 1
  | { kind: "weekday"; weekday: number; qualifier?: "this" | "next" }; // 0=Sun..6=Sat

export type TimeSpec =
  | { kind: "explicitTime"; hour: number; minute: number } // 24h, local to the business
  | { kind: "partOfDay"; part: "morning" | "afternoon" | "evening" };

export type SchedulingConstraint = { date?: DateSpec; time?: TimeSpec };

const partOfDayHour: Record<"morning" | "afternoon" | "evening", number> = {
  morning: 9,
  afternoon: 14,
  evening: 18,
};

type LocalDateParts = { year: number; month: number; day: number; weekday: number };

const WEEKDAY_SHORT_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The current date, as a calendar day in `timeZone` — not the server's local day. */
function currentLocalDate(timeZone: string, now: Date): LocalDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: WEEKDAY_SHORT_NAMES.indexOf(map.weekday),
  };
}

/** Add `days` calendar days to a Y/M/D triple (via UTC arithmetic — safe, no wall-clock/DST involved yet). */
function addCalendarDays(date: LocalDateParts, days: number): { year: number; month: number; day: number } {
  const asUtc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  asUtc.setUTCDate(asUtc.getUTCDate() + days);
  return { year: asUtc.getUTCFullYear(), month: asUtc.getUTCMonth() + 1, day: asUtc.getUTCDate() };
}

/** The UTC offset (ms) in effect in `timeZone` AT a given instant — instant->local is always well-defined, so this is never ambiguous, unlike the reverse direction `zonedTimeToUtc` has to solve. */
function offsetAtInstant(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const displayedAsUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return instant - displayedAsUtc;
}

/** Does `instant`, displayed in `timeZone`, read back as exactly the requested wall-clock Y/M/D H:M? */
function displaysAsRequested(
  instant: number,
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return (
    Number(map.year) === year &&
    Number(map.month) === month &&
    Number(map.day) === day &&
    Number(map.hour) === hour &&
    Number(map.minute) === minute
  );
}

export type ZonedTimeResult = {
  instant: Date;
  /**
   * Set when the requested local wall-clock time falls inside a DST
   * transition — this is BARRY's own documented, deterministic policy
   * for the two cases a naive UTC offset lookup can't otherwise resolve;
   * it never silently guesses without recording that a decision was
   * made:
   *
   * - "nonexistent": a spring-forward gap skipped the requested wall
   *   clock entirely (e.g. 2:30 AM on the day clocks jump from 2:00 AM
   *   straight to 3:00 AM). Policy: round forward to the first valid
   *   instant after the gap (the POST-transition offset applied to the
   *   requested digits).
   * - "ambiguous": a fall-back means the requested wall clock occurs
   *   TWICE (e.g. 1:30 AM happens once before and once after clocks
   *   fall back). Policy: prefer the EARLIER of the two real instants
   *   (the first occurrence, still in the pre-transition offset).
   */
  anomaly?: "nonexistent" | "ambiguous";
};

/**
 * Convert a wall-clock local time in `timeZone` to the corresponding UTC
 * instant. Standard round-trip technique: guess the instant as if the wall
 * clock were UTC, see what that instant actually displays as in
 * `timeZone`, and correct by the difference — correct for an ordinary
 * (non-transition) time. Near a DST transition, that single guess-and-
 * correct pass isn't enough (the "true" offset could be either side of
 * the transition), so this probes BOTH sides explicitly and applies the
 * documented policy above instead of silently returning whichever one
 * the naive technique happened to land on.
 */
/**
 * How far before/after the naive guess to probe for the surrounding UTC
 * offset. Must exceed the largest realistic IANA UTC offset magnitude
 * (up to ~14h) plus the DST gap/overlap itself (1-2h): the naive guess
 * treats the requested LOCAL digits as if they were UTC, so for a zone
 * like America/New_York (UTC-5) the guess can sit hours away from the
 * real transition instant — a 3-hour probe window entirely missed it. 25
 * hours safely brackets any single transition without risking a second
 * one inside the window (transitions are always months apart).
 */
const DST_PROBE_MS = 25 * 3600_000;

function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): ZonedTimeResult {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);

  const offsetBefore = offsetAtInstant(guess - DST_PROBE_MS, timeZone);
  const offsetAfter = offsetAtInstant(guess + DST_PROBE_MS, timeZone);

  if (offsetBefore === offsetAfter) {
    // No DST transition anywhere near this instant — the ordinary case.
    return { instant: new Date(guess + offsetBefore) };
  }

  const candidateBefore = guess + offsetBefore;
  const candidateAfter = guess + offsetAfter;
  const beforeMatches = displaysAsRequested(candidateBefore, timeZone, year, month, day, hour, minute);
  const afterMatches = displaysAsRequested(candidateAfter, timeZone, year, month, day, hour, minute);

  if (beforeMatches && afterMatches) {
    return { instant: new Date(Math.min(candidateBefore, candidateAfter)), anomaly: "ambiguous" };
  }
  if (beforeMatches) return { instant: new Date(candidateBefore) };
  if (afterMatches) return { instant: new Date(candidateAfter) };

  // Neither reformatted candidate matches the requested wall clock at
  // all — it was skipped by a spring-forward gap. Round forward to the
  // first valid instant after the gap.
  return { instant: new Date(Math.max(candidateBefore, candidateAfter)), anomaly: "nonexistent" };
}

function resolveDate(
  spec: DateSpec | undefined,
  timeZone: string,
  now: Date,
  time: { hour: number; minute: number }
): { year: number; month: number; day: number } {
  const today = currentLocalDate(timeZone, now);
  if (!spec) return today;

  switch (spec.kind) {
    case "explicitDate": {
      const [y, m, d] = spec.isoDate.split("-").map(Number);
      return { year: y, month: m, day: d };
    }
    case "relativeDay":
      return addCalendarDays(today, spec.days);
    case "weekday": {
      const diff = (spec.weekday - today.weekday + 7) % 7;
      let days: number;
      if (diff === 0) {
        // Today IS the requested weekday. "next Sunday" always skips
        // today, even when today is Sunday. Bare/"this" Sunday means
        // TODAY if the requested time hasn't passed yet in the
        // business's own local time — otherwise it rolls to next week
        // (never silently jumps to some other, unrelated weekday).
        if (spec.qualifier === "next") {
          days = 7;
        } else {
          const candidate = zonedTimeToUtc(today.year, today.month, today.day, time.hour, time.minute, timeZone);
          days = candidate.instant.getTime() >= now.getTime() ? 0 : 7;
        }
      } else {
        // "next Monday" skips past the immediate upcoming Monday to the
        // one after — distinct from bare "Monday", which is the coming one.
        days = spec.qualifier === "next" ? diff + 7 : diff;
      }
      return addCalendarDays(today, days);
    }
  }
}

function resolveTime(spec: TimeSpec | undefined): { hour: number; minute: number } {
  if (!spec) return { hour: 9, minute: 0 };
  if (spec.kind === "explicitTime") return { hour: spec.hour, minute: spec.minute };
  return { hour: partOfDayHour[spec.part], minute: 0 };
}

/**
 * Resolve a semantic scheduling constraint to an absolute UTC window,
 * using the business's own timezone. Returns undefined if there's nothing
 * to resolve (no date and no time mentioned at all). `anomaly` is set
 * when the requested local time fell inside a DST transition — see
 * `ZonedTimeResult`'s docstring for the exact policy applied; this is
 * never a silent guess, it's always observable here for the compiler/
 * Inspector to surface if useful.
 */
export function resolveSchedulingWindow(
  constraint: SchedulingConstraint,
  timeZone: string,
  now: Date = new Date()
): { earliest: string; latest: string; anomaly?: "nonexistent" | "ambiguous" } | undefined {
  if (!constraint.date && !constraint.time) return undefined;

  const { hour, minute } = resolveTime(constraint.time);
  const { year, month, day } = resolveDate(constraint.date, timeZone, now, { hour, minute });

  const earliest = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
  const latestInstant = new Date(earliest.instant);
  latestInstant.setUTCHours(latestInstant.getUTCHours() + 3);

  return {
    earliest: earliest.instant.toISOString(),
    latest: latestInstant.toISOString(),
    anomaly: earliest.anomaly,
  };
}

/**
 * Format a UTC instant for a CUSTOMER-FACING reply, always in the
 * business's own local timezone — never the server's. This is the ONE
 * place any reasoner's display copy for a scheduling instant should come
 * from; no reasoner (LLM or deterministic) is trusted to interpret a raw
 * ISO string itself, because that silently defaults to the server's
 * runtime timezone (often UTC) and shows the wrong hour to the customer.
 */
/**
 * `localTime` is 12-hour ("2:00 PM") and `localTime24` is 24-hour
 * ("14:00") — the SAME instant, two renderings. Neither is "the"
 * correct one: English replies conventionally use 12-hour, Hebrew ones
 * conventionally use 24-hour (embedding an English "2:00 PM" inside a
 * Hebrew sentence reads as foreign/awkward). Which one a reply should
 * use depends on what LANGUAGE that reply is in — not on the business's
 * own fixed locale, since a Hebrew-speaking customer can message an
 * English-locale business and vice versa (see the mixed-language eval
 * suite). BARRY only ever computes both ground-truth strings; a
 * reasoner picks between them based on the language it's already
 * replying in, never computing or converting either one itself.
 */
export type LocalDisplay = { iso: string; localDate: string; localTime: string; localTime24: string; timeZone: string };

export function formatLocalDateTime(iso: string, timeZone: string): LocalDisplay {
  const date = new Date(iso);
  const localDate = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
  const localTime = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  const localTime24 = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return { iso, localDate, localTime, localTime24, timeZone };
}
