import type { AvailabilitySlot } from "@/lib/business-graph";

/** Generate daily slots for a resource across the next `days` days at the given hours (24h, local). */
export function generateDailySlots(
  resourceId: string,
  days: number,
  hours: number[],
  durationMinutes: number,
  startFrom: Date = new Date()
): AvailabilitySlot[] {
  const slots: AvailabilitySlot[] = [];
  for (let d = 1; d <= days; d++) {
    const day = new Date(startFrom);
    day.setDate(day.getDate() + d);
    for (const hour of hours) {
      const start = new Date(day);
      start.setHours(hour, 0, 0, 0);
      const end = new Date(start.getTime() + durationMinutes * 60_000);
      slots.push({ resourceId, start: start.toISOString(), end: end.toISOString() });
    }
  }
  return slots;
}
