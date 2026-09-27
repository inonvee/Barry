import type { AvailabilitySlot } from "@/lib/business-graph";
import { resolveSchedulingWindow } from "@/lib/scheduling/resolver";

/**
 * Generate daily slots for a resource across `days` days starting TODAY
 * (day 0) in the given local hours, anchored to `timeZone` — the same
 * business timezone a real BusinessGraph declares, resolved through the
 * same deterministic scheduling resolver the runtime uses. Slots must be
 * generated relative to the business's own timezone, not the server's, or
 * a correctly timezone-aware booking request can miss them entirely.
 *
 * Starting at day 0 (not day 1/"tomorrow") matters: a real business can
 * have same-day availability, and the scheduling resolver now correctly
 * resolves a bare "Sunday at 1pm" to TODAY when today is Sunday and that
 * time hasn't passed yet — a fixture that only ever modeled availability
 * starting tomorrow would make same-day requests spuriously come back
 * with zero slots.
 */
export function generateDailySlots(
  resourceId: string,
  days: number,
  hours: number[],
  durationMinutes: number,
  timeZone: string,
  startFrom: Date = new Date()
): AvailabilitySlot[] {
  const slots: AvailabilitySlot[] = [];
  for (let d = 0; d < days; d++) {
    for (const hour of hours) {
      const resolved = resolveSchedulingWindow(
        { date: { kind: "relativeDay", days: d }, time: { kind: "explicitTime", hour, minute: 0 } },
        timeZone,
        startFrom
      )!;
      const end = new Date(new Date(resolved.earliest).getTime() + durationMinutes * 60_000);
      slots.push({ resourceId, start: resolved.earliest, end: end.toISOString() });
    }
  }
  return slots;
}
