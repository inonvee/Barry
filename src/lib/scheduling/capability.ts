import { getBackend } from "@/lib/store";
import { GoogleCalendarAdapter } from "./adapters/google-calendar";
import { MemorySchedulingAdapter } from "./adapters/memory";
import type { CheckAvailabilityInput, CreateBookingInput, SchedulingAdapter } from "./adapters/types";

let adapterOverride: SchedulingAdapter | undefined;

export function setSchedulingAdapterForTests(adapter: SchedulingAdapter | undefined): void {
  adapterOverride = adapter;
}

export function getSchedulingAdapter(): SchedulingAdapter {
  if (adapterOverride) return adapterOverride;
  if (process.env.BARRY_SCHEDULING_PROVIDER === "google-calendar") {
    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    if (!calendarId) throw new Error("Google Calendar auth invalid");
    return new GoogleCalendarAdapter({ calendarId, backend: getBackend() });
  }
  return new MemorySchedulingAdapter(getBackend());
}

export async function checkSchedulingAvailability(input: CheckAvailabilityInput) {
  return getSchedulingAdapter().checkAvailability(input);
}

export async function createSchedulingBooking(input: CreateBookingInput) {
  return getSchedulingAdapter().createBooking(input);
}

export function bookingIdempotencyKey(input: Omit<CreateBookingInput, "idempotencyKey" | "graph"> & { businessId: string }): string {
  return [
    input.businessId,
    input.conversationId,
    input.customerId,
    input.offerId,
    input.resourceId,
    input.start,
    input.end,
  ].join(":");
}
