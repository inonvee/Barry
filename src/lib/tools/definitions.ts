import { z } from "zod";
import { defineTool } from "./types";
import { findOffer, resourcesByType, inventoryFor } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";

/**
 * Simulated tool adapters. Each mirrors what a real integration (Google
 * Calendar, Stripe, a POS) will eventually do, but operates entirely against
 * the Business Graph + in-memory backend so Phase 1 needs no external
 * credentials. Swapping in a real adapter later only touches this file.
 */

export const checkAvailability = defineTool({
  name: "checkAvailability",
  description: "Find open time slots for an offer that requires scheduling.",
  inputSchema: z.object({
    offerId: z.string(),
    earliest: z.string(), // ISO datetime
    latest: z.string().optional(),
    partySize: z.number().int().positive().default(1),
  }),
  outputSchema: z.object({
    slots: z.array(z.object({ resourceId: z.string(), start: z.string(), end: z.string() })),
  }),
  async execute(input, ctx) {
    const offer = findOffer(ctx.graph, input.offerId);
    if (!offer) return { slots: [] };

    const resourceIds = new Set(
      offer.requiredResourceTypes.flatMap((type) =>
        resourcesByType(ctx.graph, type).map((r) => r.id)
      )
    );

    const backend = getBackend();
    const bookings = await backend.listBookings(ctx.graph.business.id);
    const bookedKeys = new Set(bookings.map((b) => `${b.resourceId}:${b.start}`));

    const latest = input.latest ? new Date(input.latest) : undefined;
    const earliest = new Date(input.earliest);

    const slots = ctx.graph.availability.filter((slot) => {
      if (resourceIds.size > 0 && !resourceIds.has(slot.resourceId)) return false;
      const start = new Date(slot.start);
      if (start < earliest) return false;
      if (latest && start > latest) return false;
      return !bookedKeys.has(`${slot.resourceId}:${slot.start}`);
    });

    return { slots: slots.map(({ resourceId, start, end }) => ({ resourceId, start, end })) };
  },
});

export const createBooking = defineTool({
  name: "createBooking",
  description: "Create a confirmed booking against a specific resource and time slot.",
  inputSchema: z.object({
    offerId: z.string(),
    resourceId: z.string(),
    start: z.string(),
    end: z.string(),
    partySize: z.number().int().positive().default(1),
  }),
  outputSchema: z.object({
    bookingId: z.string(),
    status: z.literal("confirmed"),
  }),
  async execute(input, ctx) {
    const backend = getBackend();
    const bookings = await backend.listBookings(ctx.graph.business.id);
    const conflict = bookings.some(
      (b) => b.resourceId === input.resourceId && b.start === input.start
    );
    if (conflict) {
      throw new Error("Slot no longer available");
    }
    const booking = await backend.createBooking({
      businessId: ctx.graph.business.id,
      offerId: input.offerId,
      resourceId: input.resourceId,
      start: input.start,
      end: input.end,
      customerId: ctx.customerId,
      conversationId: ctx.conversationId,
      partySize: input.partySize,
    });
    return { bookingId: booking.id, status: "confirmed" as const };
  },
});

export const checkInventory = defineTool({
  name: "checkInventory",
  description: "Check remaining stock for a product SKU.",
  inputSchema: z.object({ offerId: z.string() }),
  outputSchema: z.object({ sku: z.string().optional(), quantityAvailable: z.number() }),
  async execute(input, ctx) {
    const offer = findOffer(ctx.graph, input.offerId);
    if (!offer?.sku) return { sku: undefined, quantityAvailable: 0 };
    const baseQuantity = inventoryFor(ctx.graph, offer.sku);
    const backend = getBackend();
    const available = await backend.getInventory(ctx.graph.business.id, offer.sku, baseQuantity);
    return { sku: offer.sku, quantityAvailable: available };
  },
});

export const createPaymentRequest = defineTool({
  name: "createPaymentRequest",
  description: "Create a payment request (deposit or full payment) for the customer to pay.",
  inputSchema: z.object({
    amount: z.number().positive(),
    currency: z.string().default("USD"),
    reason: z.string(),
  }),
  outputSchema: z.object({
    paymentRequestId: z.string(),
    status: z.literal("pending"),
  }),
  async execute(input, ctx) {
    const backend = getBackend();
    const pr = await backend.createPaymentRequest({
      businessId: ctx.graph.business.id,
      conversationId: ctx.conversationId,
      customerId: ctx.customerId,
      amount: input.amount,
      currency: input.currency,
      reason: input.reason,
    });
    return { paymentRequestId: pr.id, status: "pending" as const };
  },
});

export const requestApproval = defineTool({
  name: "requestApproval",
  description: "Escalate a decision to the business owner because policy requires human sign-off.",
  inputSchema: z.object({
    requestedAction: z.string(),
    requestedInput: z.unknown(),
    reason: z.string(),
    policyId: z.string(),
    proposedValue: z.unknown().optional(),
  }),
  outputSchema: z.object({ approvalId: z.string(), status: z.literal("pending") }),
  async execute(input, ctx) {
    const backend = getBackend();
    const approval = await backend.createApproval({
      businessId: ctx.graph.business.id,
      conversationId: ctx.conversationId,
      customerId: ctx.customerId,
      requestedAction: input.requestedAction,
      requestedInput: input.requestedInput,
      reason: input.reason,
      policyId: input.policyId,
      proposedValue: input.proposedValue,
    });
    return { approvalId: approval.id, status: "pending" as const };
  },
});

export const createFollowUp = defineTool({
  name: "createFollowUp",
  description: "Schedule a future follow-up message to the customer (e.g. abandoned cart recovery).",
  inputSchema: z.object({
    reason: z.string(),
    dueAt: z.string(),
  }),
  outputSchema: z.object({ followUpId: z.string(), status: z.literal("scheduled") }),
  async execute(input, ctx) {
    const backend = getBackend();
    const followUp = await backend.createFollowUp({
      businessId: ctx.graph.business.id,
      conversationId: ctx.conversationId,
      customerId: ctx.customerId,
      reason: input.reason,
      dueAt: input.dueAt,
    });
    return { followUpId: followUp.id, status: "scheduled" as const };
  },
});

export const fulfillOrder = defineTool({
  name: "fulfillOrder",
  description: "Finalize a paid product order: decrement inventory and mark it fulfilled.",
  inputSchema: z.object({ offerId: z.string() }),
  outputSchema: z.object({ orderId: z.string(), status: z.literal("fulfilled") }),
  async execute(input, ctx) {
    const offer = findOffer(ctx.graph, input.offerId);
    const backend = getBackend();
    if (offer?.sku) {
      await backend.decrementInventory(ctx.graph.business.id, offer.sku, 1);
    }
    return { orderId: `order_${Math.random().toString(36).slice(2, 10)}`, status: "fulfilled" as const };
  },
});

export const createLead = defineTool({
  name: "createLead",
  description: "Record a qualified lead when the customer isn't ready to transact yet.",
  inputSchema: z.object({
    summary: z.string(),
    contactInfo: z.string().optional(),
  }),
  outputSchema: z.object({ leadId: z.string() }),
  async execute() {
    return { leadId: `lead_${Math.random().toString(36).slice(2, 10)}` };
  },
});

export const sendMedia = defineTool({
  name: "sendMedia",
  description: "Send a photo, catalog, or document to the customer.",
  inputSchema: z.object({ mediaRef: z.string(), caption: z.string().optional() }),
  outputSchema: z.object({ sent: z.boolean() }),
  async execute() {
    return { sent: true };
  },
});
