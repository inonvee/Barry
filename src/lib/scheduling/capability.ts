import type { CheckAvailabilityInput, CreateBookingInput, SchedulingAdapter } from "./adapters/types";
import { resolveSchedulingAdapterForBusiness } from "./registry";

let adapterOverride: SchedulingAdapter | undefined;

export function setSchedulingAdapterForTests(adapter: SchedulingAdapter | undefined): void {
  adapterOverride = adapter;
}

export function getSchedulingAdapter(): SchedulingAdapter {
  if (adapterOverride) return adapterOverride;
  throw new Error("Scheduling adapter requires a business connection");
}

export async function checkSchedulingAvailability(input: CheckAvailabilityInput) {
  const adapter = adapterOverride ?? (await resolveSchedulingAdapterForBusiness(input.graph.business.id));
  return adapter.checkAvailability(input);
}

export async function createSchedulingBooking(input: CreateBookingInput) {
  const adapter = adapterOverride ?? (await resolveSchedulingAdapterForBusiness(input.graph.business.id));
  return adapter.createBooking(input);
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
