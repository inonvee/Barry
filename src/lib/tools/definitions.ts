import { z } from "zod";
import { defineTool } from "./types";
import { findOffer, inventoryFor } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { bookingIdempotencyKey, checkSchedulingAvailability, createSchedulingBooking } from "@/lib/scheduling/capability";
import { createPaymentLink } from "@/lib/payments/capability";
import {
  addCommerceItem,
  commerceOrderIdempotencyKey,
  createCommerceCheckout as createCommerceCheckoutCapability,
  createCommerceOrder as createCommerceOrderCapability,
  ensureCommerceCart,
  getCommerceProduct,
  saveCommerceCart,
  searchCommerceProducts,
} from "@/lib/commerce/capability";
import type { Product } from "@/lib/commerce/types";

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
    return checkSchedulingAvailability({ graph: ctx.graph, ...input });
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
    provider: z.string().optional(),
    providerEventId: z.string().optional(),
    verifiedAt: z.string().optional(),
  }),
  async execute(input, ctx) {
    const booking = await createSchedulingBooking({
      graph: ctx.graph,
      ...input,
      customerId: ctx.customerId,
      conversationId: ctx.conversationId,
      idempotencyKey: bookingIdempotencyKey({
        businessId: ctx.graph.business.id,
        ...input,
        customerId: ctx.customerId,
        conversationId: ctx.conversationId,
      }),
    });
    return {
      bookingId: booking.bookingId,
      status: booking.status,
      provider: booking.provider,
      providerEventId: booking.providerEventId,
      verifiedAt: booking.verifiedAt,
    };
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
    provider: z.string().optional(),
    providerPaymentId: z.string().optional(),
    checkoutUrl: z.string().optional(),
    idempotencyKey: z.string().optional(),
    createdAt: z.string().optional(),
  }),
  async execute(input, ctx) {
    const pr = await createPaymentLink({
      graph: ctx.graph,
      businessId: ctx.graph.business.id,
      conversationId: ctx.conversationId,
      customerId: ctx.customerId,
      amount: input.amount,
      currency: input.currency,
      reason: input.reason,
    });
    return {
      paymentRequestId: pr.paymentRequestId,
      status: "pending" as const,
      provider: pr.provider,
      providerPaymentId: pr.providerPaymentId,
      checkoutUrl: pr.checkoutUrl,
      idempotencyKey: pr.idempotencyKey,
      createdAt: pr.createdAt,
    };
  },
});

const moneySchema = z.object({ amount: z.number(), currency: z.string() });
const variantSchema = z.object({
  id: z.string(),
  sku: z.string(),
  title: z.string(),
  options: z.record(z.string(), z.string()),
  price: moneySchema,
  inventory: z.object({ available: z.number() }),
});
const productSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  attributes: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  media: z.array(z.object({ url: z.string(), alt: z.string() })),
  url: z.string().optional(),
  variants: z.array(variantSchema),
});
const cartLineSchema = z.object({
  id: z.string(),
  productId: z.string(),
  variantId: z.string(),
  title: z.string(),
  quantity: z.number(),
  unitPrice: moneySchema,
  options: z.record(z.string(), z.string()),
});
const cartSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  customerId: z.string(),
  conversationId: z.string(),
  lines: z.array(cartLineSchema),
  total: moneySchema,
  status: z.enum(["open", "checkout", "ordered"]),
  providerCartId: z.string().optional(),
});

function variantFor(product: Product, size?: string) {
  const wanted = size?.toLowerCase();
  return (
    product.variants.find((variant) => (!wanted || variant.options.size?.toLowerCase() === wanted) && variant.inventory.available > 0) ??
    product.variants.find((variant) => variant.inventory.available > 0)
  );
}

export const searchProducts = defineTool({
  name: "searchProducts",
  description: "Search grounded catalog products through the commerce capability.",
  inputSchema: z.object({
    text: z.string().optional(),
    category: z.string().optional(),
    occasion: z.string().optional(),
    color: z.string().optional(),
    size: z.string().optional(),
    budgetAmount: z.number().optional(),
    currency: z.string().optional(),
  }),
  outputSchema: z.object({ products: z.array(productSchema) }),
  async execute(input, ctx) {
    const result = await searchCommerceProducts(ctx.graph, {
      text: input.text,
      category: input.category,
      occasion: input.occasion,
      color: input.color,
      size: input.size,
      budget: input.budgetAmount ? { amount: input.budgetAmount, currency: input.currency ?? "ILS" } : undefined,
    });
    return result;
  },
});

export const addToCart = defineTool({
  name: "addToCart",
  description: "Add a grounded product variant to the active commerce cart.",
  inputSchema: z.object({
    productId: z.string(),
    size: z.string().optional(),
    quantity: z.number().int().positive().default(1),
  }),
  outputSchema: z.object({
    cart: cartSchema,
    lineId: z.string().optional(),
    requestedAvailable: z.boolean(),
    selectedSize: z.string().optional(),
  }),
  async execute(input, ctx) {
    const product = await getCommerceProduct(ctx.graph, input.productId);
    if (!product) throw new Error("Product not found");
    const exact = input.size
      ? product.variants.find(
          (variant) => variant.options.size?.toLowerCase() === input.size?.toLowerCase() && variant.inventory.available >= input.quantity
        )
      : undefined;
    const selected = exact ?? variantFor(product, input.size);
    if (!selected) throw new Error("Requested variant not available");
    const cart = await addCommerceItem({
      graph: ctx.graph,
      customerId: ctx.customerId,
      conversationId: ctx.conversationId,
      productId: product.id,
      variantId: selected.id,
      quantity: input.quantity,
    });
    const line = cart.lines.find((cartLine) => cartLine.variantId === selected.id);
    return {
      cart,
      lineId: line?.id,
      requestedAvailable: Boolean(exact || !input.size),
      selectedSize: selected.options.size,
    };
  },
});

export const updateCartLine = defineTool({
  name: "updateCartLine",
  description: "Update the active commerce cart line size or quantity.",
  inputSchema: z.object({
    cartId: z.string(),
    lineId: z.string(),
    size: z.string().optional(),
    quantity: z.number().int().positive().default(1),
  }),
  outputSchema: z.object({ cart: cartSchema, lineId: z.string().optional(), selectedSize: z.string().optional() }),
  async execute(input, ctx) {
    const cart = await ensureCommerceCart({ graph: ctx.graph, customerId: ctx.customerId, conversationId: ctx.conversationId });
    const line = cart.lines.find((cartLine) => cartLine.id === input.lineId);
    if (!line) throw new Error("Cart is empty");
    if (!input.size || line.options.size?.toLowerCase() === input.size.toLowerCase()) {
      const saved = await saveCommerceCart({
        graph: ctx.graph,
        customerId: ctx.customerId,
        conversationId: ctx.conversationId,
        cart: { ...cart, lines: cart.lines.map((cartLine) => cartLine.id === line.id ? { ...cartLine, quantity: input.quantity } : cartLine) },
      });
      return { cart: saved, lineId: line.id, selectedSize: line.options.size };
    }
    const product = await getCommerceProduct(ctx.graph, line.productId);
    const variant = product?.variants.find(
      (candidate) => candidate.options.size?.toLowerCase() === input.size?.toLowerCase() && candidate.inventory.available >= input.quantity
    );
    if (!product || !variant) throw new Error("Requested variant not available");
    const updatedLines = cart.lines.map((cartLine) =>
      cartLine.id === line.id
        ? { ...cartLine, variantId: variant.id, unitPrice: variant.price, options: variant.options, quantity: input.quantity }
        : cartLine
    );
    const total = {
      amount: Math.round(updatedLines.reduce((sum, cartLine) => sum + cartLine.unitPrice.amount * cartLine.quantity, 0) * 100) / 100,
      currency: updatedLines[0]?.unitPrice.currency ?? "ILS",
    };
    const saved = await saveCommerceCart({
      graph: ctx.graph,
      customerId: ctx.customerId,
      conversationId: ctx.conversationId,
      cart: { ...cart, lines: updatedLines, total },
    });
    return { cart: saved, lineId: line.id, selectedSize: variant.options.size };
  },
});

export const createCommerceCheckout = defineTool({
  name: "createCommerceCheckout",
  description: "Create a verified commerce checkout and matching payment request.",
  inputSchema: z.object({ cartId: z.string() }),
  outputSchema: z.object({
    checkoutId: z.string(),
    cartId: z.string(),
    amount: moneySchema,
    status: z.literal("pending"),
    paymentRequestId: z.string(),
    checkoutUrl: z.string().optional(),
  }),
  async execute(_input, ctx) {
    const checkout = await createCommerceCheckoutCapability({
      graph: ctx.graph,
      customerId: ctx.customerId,
      conversationId: ctx.conversationId,
    });
    const pr = await createPaymentLink({
      graph: ctx.graph,
      businessId: ctx.graph.business.id,
      conversationId: ctx.conversationId,
      customerId: ctx.customerId,
      amount: checkout.amount.amount,
      currency: checkout.amount.currency,
      reason: `Commerce checkout ${checkout.cartId}`,
    });
    return {
      checkoutId: checkout.id,
      cartId: checkout.cartId,
      amount: checkout.amount,
      status: "pending" as const,
      paymentRequestId: pr.paymentRequestId,
      checkoutUrl: pr.checkoutUrl,
    };
  },
});

export const createCommerceOrder = defineTool({
  name: "createCommerceOrder",
  description: "Create exactly one verified commerce order after payment is verified.",
  inputSchema: z.object({ cartId: z.string() }),
  outputSchema: z.object({
    orderId: z.string(),
    cartId: z.string(),
    status: z.literal("paid"),
    total: moneySchema,
    verifiedAt: z.string(),
  }),
  async execute(input, ctx) {
    const order = await createCommerceOrderCapability({
      graph: ctx.graph,
      customerId: ctx.customerId,
      conversationId: ctx.conversationId,
      cartId: input.cartId,
      idempotencyKey: commerceOrderIdempotencyKey({
        businessId: ctx.graph.business.id,
        conversationId: ctx.conversationId,
        cartId: input.cartId,
      }),
    });
    return { orderId: order.id, cartId: order.cartId, status: "paid" as const, total: order.total, verifiedAt: order.verifiedAt };
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
    if (offer?.sku) {
      const backend = getBackend();
      // Stock was last confirmed at checkInventory time, potentially many
      // turns (and a full payment flow) ago — another customer's order
      // could have consumed the same last unit in between. Re-validate
      // and reserve atomically HERE, at the moment of actual fulfillment,
      // never trust the earlier check alone. A customer has already
      // PAID by this point, so "sold out" here is a genuine failure to
      // report, never something to paper over by fulfilling anyway.
      const baseQuantity = inventoryFor(ctx.graph, offer.sku);
      const reserved = await backend.decrementInventory(ctx.graph.business.id, offer.sku, 1, baseQuantity);
      if (!reserved) {
        throw new Error("Item sold out before this order could be fulfilled");
      }
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
