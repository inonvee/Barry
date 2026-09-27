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

/**
 * Convert a wall-clock local time in `timeZone` to the corresponding UTC
 * instant. Standard round-trip technique: guess the instant as if the wall
 * clock were UTC, see what that instant actually displays as in
 * `timeZone`, and correct by the difference.
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(guess));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const displayedAsUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  const offset = guess - displayedAsUtc;
  return new Date(guess + offset);
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
          const candidateInstant = zonedTimeToUtc(today.year, today.month, today.day, time.hour, time.minute, timeZone);
          days = candidateInstant.getTime() >= now.getTime() ? 0 : 7;
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
 * to resolve (no date and no time mentioned at all).
 */
export function resolveSchedulingWindow(
  constraint: SchedulingConstraint,
  timeZone: string,
  now: Date = new Date()
): { earliest: string; latest: string } | undefined {
  if (!constraint.date && !constraint.time) return undefined;

  const { hour, minute } = resolveTime(constraint.time);
  const { year, month, day } = resolveDate(constraint.date, timeZone, now, { hour, minute });

  const earliest = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
  const latest = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
  latest.setUTCHours(latest.getUTCHours() + 3);

  return { earliest: earliest.toISOString(), latest: latest.toISOString() };
}

/**
 * Format a UTC instant for a CUSTOMER-FACING reply, always in the
 * business's own local timezone — never the server's. This is the ONE
 * place any reasoner's display copy for a scheduling instant should come
 * from; no reasoner (LLM or deterministic) is trusted to interpret a raw
 * ISO string itself, because that silently defaults to the server's
 * runtime timezone (often UTC) and shows the wrong hour to the customer.
 */
export type LocalDisplay = { iso: string; localDate: string; localTime: string; timeZone: string };

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
  return { iso, localDate, localTime, timeZone };
}
