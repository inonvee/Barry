/**
 * TIME IN THE PRODUCT — every timestamp an owner or the founder reads is shown in the BUSINESS's
 * timezone, in words a person would say ("Today 14:05", "Tue 30 Sep, 09:12"). Raw ISO strings belong
 * only to technical trace views. Pure: the caller passes `now` (render stays pure for lint).
 */

const DAY = 86_400_000;

function parts(iso: string, timeZone: string): { date: string; time: string; weekday: string; day: string; month: string; year: string } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  try {
    const f = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    const p = Object.fromEntries(f.formatToParts(new Date(t)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
    return { date: `${p.day} ${p.month} ${p.year}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday, day: p.day, month: p.month, year: p.year };
  } catch {
    return null;
  }
}

/** The calendar day of an instant in a timezone, as "YYYY-MM-DD" (for same-day / yesterday checks). */
export function localDay(iso: string | Date, timeZone: string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * "14:05" when today in the business timezone, "Yesterday 14:05", "Tue 30 Sep, 14:05" within the
 * year, "30 Sep 2025, 14:05" otherwise. Unparseable input returns "—".
 */
export function formatLocal(iso: string | null | undefined, timeZone: string, now: Date = new Date(0)): string {
  if (!iso) return "—";
  const p = parts(iso, timeZone);
  if (!p) return "—";
  if (now.getTime() > 0) {
    const today = localDay(now, timeZone);
    const day = localDay(iso, timeZone);
    if (day === today) return `Today ${p.time}`;
    if (day === localDay(new Date(now.getTime() - DAY), timeZone)) return `Yesterday ${p.time}`;
    if (now.getTime() - Date.parse(iso) < 6 * DAY && now.getTime() >= Date.parse(iso)) return `${p.weekday} ${p.time}`;
    if (p.year === localDay(now, timeZone).slice(0, 4)) return `${p.weekday} ${p.day} ${p.month}, ${p.time}`;
  }
  return `${p.day} ${p.month} ${p.year}, ${p.time}`;
}

/** Relative words for a past instant ("just now", "12 min ago", "3 h ago", "2 days ago"); future → "in …". */
export function relativeWords(iso: string | null | undefined, now: Date): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = now.getTime() - t;
  const abs = Math.abs(diff);
  const future = diff < 0;
  const w = abs < 45_000 ? "just now" : abs < 3_600_000 ? `${Math.max(1, Math.round(abs / 60_000))} min` : abs < DAY ? `${Math.round(abs / 3_600_000)} h` : abs < 30 * DAY ? `${Math.round(abs / DAY)} day${Math.round(abs / DAY) === 1 ? "" : "s"}` : `${Math.round(abs / (30 * DAY))} mo`;
  if (w === "just now") return future ? "any moment" : w;
  return future ? `in ${w}` : `${w} ago`;
}

/** A short clock-only form in the business timezone ("14:05"). */
export function formatClock(iso: string, timeZone: string): string {
  return parts(iso, timeZone)?.time ?? "—";
}
