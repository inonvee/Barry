import type { BusinessGraph } from "@/lib/business-graph";

export type SchedulingSlot = {
  resourceId: string;
  start: string;
  end: string;
};

export type SchedulingBooking = SchedulingSlot & {
  bookingId: string;
  status: "confirmed";
  provider?: "memory" | "google-calendar";
  providerEventId?: string;
  idempotencyKey: string;
  verifiedAt: string;
};

export type CheckAvailabilityInput = {
  graph: BusinessGraph;
  offerId: string;
  earliest: string;
  latest?: string;
  partySize: number;
};

export type CreateBookingInput = {
  graph: BusinessGraph;
  offerId: string;
  resourceId: string;
  start: string;
  end: string;
  customerId: string;
  conversationId: string;
  partySize: number;
  idempotencyKey: string;
};

export interface SchedulingAdapter {
  readonly name: "memory" | "google-calendar";
  checkAvailability(input: CheckAvailabilityInput): Promise<{ slots: SchedulingSlot[] }>;
  createBooking(input: CreateBookingInput): Promise<SchedulingBooking>;
  getBooking(providerEventId: string): Promise<SchedulingBooking | undefined>;
}
