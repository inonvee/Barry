import type { AvailabilitySlot } from "@/lib/business-graph";
import { resolveSchedulingWindow } from "@/lib/scheduling/resolver";

/**
 * Generate daily slots for a resource across the next `days` days at the
 * given local hours, anchored to `timeZone` — the same business timezone
 * a real BusinessGraph declares, resolved through the same deterministic
 * scheduling resolver the runtime uses. Slots must be generated relative
 * to the business's own timezone, not the server's, or a correctly
 * timezone-aware booking request can miss them entirely.
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
  for (let d = 1; d <= days; d++) {
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
