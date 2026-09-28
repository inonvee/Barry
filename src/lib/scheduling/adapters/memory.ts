import { findOffer, resourcesByType } from "@/lib/business-graph";
import type { BarryBackend, BookingRecord } from "@/lib/store";
import type { CheckAvailabilityInput, CreateBookingInput, SchedulingAdapter, SchedulingBooking } from "./types";

function bookingToSchedulingBooking(record: BookingRecord): SchedulingBooking {
  return {
    bookingId: record.id,
    resourceId: record.resourceId,
    start: record.start,
    end: record.end,
    status: "confirmed",
    provider: record.provider ?? "memory",
    providerEventId: record.providerEventId,
    idempotencyKey: record.idempotencyKey ?? record.id,
    verifiedAt: record.verifiedAt ?? record.createdAt,
  };
}

export class MemorySchedulingAdapter implements SchedulingAdapter {
  readonly name = "memory" as const;
  async describeCapabilities(): Promise<readonly string[]> {
    return ["availability", "booking", "bookingLookup"];
  }

  constructor(private readonly backend: BarryBackend) {}

  async checkAvailability(input: CheckAvailabilityInput): Promise<{ slots: { resourceId: string; start: string; end: string }[] }> {
    const offer = findOffer(input.graph, input.offerId);
    if (!offer) return { slots: [] };

    const resourceIds = new Set(
      offer.requiredResourceTypes.flatMap((type) => resourcesByType(input.graph, type).map((r) => r.id))
    );
    const bookings = await this.backend.listBookings(input.graph.business.id);
    const bookedKeys = new Set(bookings.map((b) => `${b.resourceId}:${b.start}`));
    const earliest = new Date(input.earliest);
    const latest = input.latest ? new Date(input.latest) : undefined;

    const slots = input.graph.availability
      .filter((slot) => {
        if (resourceIds.size > 0 && !resourceIds.has(slot.resourceId)) return false;
        const start = new Date(slot.start);
        if (start < earliest) return false;
        if (latest && start > latest) return false;
        return !bookedKeys.has(`${slot.resourceId}:${slot.start}`);
      })
      .map(({ resourceId, start, end }) => ({ resourceId, start, end }));

    return { slots };
  }

  async createBooking(input: CreateBookingInput): Promise<SchedulingBooking> {
    const existing = (await this.backend.listBookings(input.graph.business.id)).find(
      (booking) => booking.idempotencyKey === input.idempotencyKey
    );
    if (existing) return bookingToSchedulingBooking(existing);

    const conflict = (await this.backend.listBookings(input.graph.business.id)).some(
      (booking) => booking.resourceId === input.resourceId && booking.start === input.start
    );
    if (conflict) throw new Error("Slot no longer available");

    const booking = await this.backend.createBooking({
      businessId: input.graph.business.id,
      offerId: input.offerId,
      resourceId: input.resourceId,
      start: input.start,
      end: input.end,
      customerId: input.customerId,
      conversationId: input.conversationId,
      partySize: input.partySize,
      provider: "memory",
      providerEventId: undefined,
      idempotencyKey: input.idempotencyKey,
      verifiedAt: new Date().toISOString(),
    });
    return bookingToSchedulingBooking(booking);
  }

  async getBooking(providerEventId: string): Promise<SchedulingBooking | undefined> {
    for (const booking of await this.backend.listBookings("")) {
      if (booking.providerEventId === providerEventId || booking.id === providerEventId) return bookingToSchedulingBooking(booking);
    }
    return undefined;
  }
}
