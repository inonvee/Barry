import { z } from "zod";
import { defineTool } from "./types";
import { findOffer, inventoryFor } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { bookingIdempotencyKey, checkSchedulingAvailability, createSchedulingBooking } from "@/lib/scheduling/capability";
import { createPaymentLink, verifyPaymentWithProvider } from "@/lib/payments/capability";
import {
  addCommerceItem,
  createCommerceCheckout as createCommerceCheckoutCapability,
  createCommerceOrder as createCommerceOrderCapability,
  getCommerceProduct,
  getOwnedCart,
  replaceCommerceLineVariant,
  resolveVariant,
  searchCommerceProducts,
  setCommerceLineQuantity,
} from "@/lib/commerce/capability";

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
const optionsSchema = z.record(z.string(), z.string());
const variantSchema = z.object({
  id: z.string(),
  sku: z.string(),
  title: z.string(),
  options: optionsSchema,
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
  options: optionsSchema,
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
/** A selection that could not be executed as asked — reported with REAL alternatives; nothing is substituted. */
const notAddedSchema = z.object({
  reason: z.enum(["unavailable", "needs_variant", "unknown_option"]),
  productId: z.string(),
  productTitle: z.string(),
  requested: optionsSchema.optional(),
  availableOptions: z.array(optionsSchema),
  /** Set when this was a swap: the line that should be replaced once a variant is chosen. */
  replacesLineId: z.string().optional(),
});

export const searchProducts = defineTool({
  name: "searchProducts",
  description: "Search grounded catalog products through the business's commerce provider.",
  inputSchema: z.object({
    text: z.string().optional(),
    category: z.string().optional(),
    attributes: optionsSchema.optional(),
    options: optionsSchema.optional(),
    budgetAmount: z.number().positive().optional(),
    currency: z.string().optional(),
  }),
  outputSchema: z.object({ products: z.array(productSchema), requestedOptions: optionsSchema.optional() }),
  async execute(input, ctx) {
    const result = await searchCommerceProducts(ctx.graph, {
      text: input.text,
      category: input.category,
      attributes: input.attributes,
      options: input.options,
      // A missing currency is the catalog's own (grounded in the capability layer).
      budget: input.budgetAmount ? { amount: input.budgetAmount, currency: input.currency } : undefined,
    });
    return { products: result.products, requestedOptions: result.query.options };
  },
});

export const addToCart = defineTool({
  name: "addToCart",
  description: "Add the exact requested product variant to the provider cart, or report real alternatives.",
  inputSchema: z.object({
    productId: z.string(),
    options: optionsSchema.optional(),
    quantity: z.number().int().positive().default(1),
    /** Swap: remove this existing line once the new item is safely in the cart. */
    replaceLine: z.object({ cartId: z.string(), lineId: z.string() }).optional(),
  }),
  outputSchema: z.object({
    added: z.boolean(),
    cart: cartSchema.optional(),
    lineId: z.string().optional(),
    replacedLineId: z.string().optional(),
    notAdded: notAddedSchema.optional(),
  }),
  async execute(input, ctx) {
    const scope = { graph: ctx.graph, customerId: ctx.customerId, conversationId: ctx.conversationId };
    if (input.replaceLine) {
      // Prove the line being replaced is this conversation's before touching anything.
      const current = await getOwnedCart(scope, input.replaceLine.cartId);
      if (!current.lines.some((l) => l.id === input.replaceLine!.lineId)) throw new Error("Cart line not found");
    }
    const product = await getCommerceProduct(ctx.graph, input.productId);
    if (!product) throw new Error("That item is no longer available");
    const resolution = resolveVariant(product, input.options, input.quantity);
    if (!resolution.ok) {
      return {
        added: false,
        notAdded: {
          reason: resolution.reason,
          productId: product.id,
          productTitle: product.title,
          requested: input.options,
          availableOptions: resolution.availableOptions,
          ...(input.replaceLine ? { replacesLineId: input.replaceLine.lineId } : {}),
        },
      };
    }
    const cart = await addCommerceItem({
      graph: ctx.graph,
      customerId: ctx.customerId,
      conversationId: ctx.conversationId,
      productId: product.id,
      variantId: resolution.variant.id,
      quantity: input.quantity,
    });
    const line = cart.lines.find((cartLine) => cartLine.variantId === resolution.variant.id);
    // Add first, then remove the replaced line: if the add fails, the
    // customer's existing item is untouched.
    if (input.replaceLine && line && line.id !== input.replaceLine.lineId && cart.lines.some((l) => l.id === input.replaceLine!.lineId)) {
      const swapped = await setCommerceLineQuantity({ ...scope, cartId: cart.id, lineId: input.replaceLine.lineId, quantity: 0 });
      return { added: true, cart: swapped, lineId: line.id, replacedLineId: input.replaceLine.lineId };
    }
    return { added: true, cart, lineId: line?.id };
  },
});

export const updateCartLine = defineTool({
  name: "updateCartLine",
  description: "Change a provider cart line's variant or quantity (0 removes it). Executed on the provider, never locally.",
  inputSchema: z.object({
    cartId: z.string(),
    lineId: z.string(),
    options: optionsSchema.optional(),
    quantity: z.number().int().min(0).optional(),
  }),
  outputSchema: z.object({
    added: z.boolean(),
    cart: cartSchema.optional(),
    lineId: z.string().optional(),
    notAdded: notAddedSchema.optional(),
  }),
  async execute(input, ctx) {
    const scope = { graph: ctx.graph, customerId: ctx.customerId, conversationId: ctx.conversationId };
    const cart = await getOwnedCart(scope, input.cartId);
    const line = cart.lines.find((cartLine) => cartLine.id === input.lineId);
    if (!line) throw new Error("Cart is empty");
    const quantity = input.quantity ?? line.quantity;

    if (!input.options || Object.keys(input.options).length === 0) {
      const updated = await setCommerceLineQuantity({ ...scope, cartId: cart.id, lineId: line.id, quantity });
      return { added: true, cart: updated, lineId: quantity === 0 ? undefined : line.id };
    }

    const product = await getCommerceProduct(ctx.graph, line.productId);
    if (!product) throw new Error("That item is no longer available");
    const resolution = resolveVariant(product, { ...line.options, ...input.options }, Math.max(quantity, 1));
    if (!resolution.ok) {
      return {
        added: false,
        cart,
        lineId: line.id,
        notAdded: {
          reason: resolution.reason,
          productId: product.id,
          productTitle: product.title,
          requested: input.options,
          availableOptions: resolution.availableOptions,
        },
      };
    }
    const updated = await replaceCommerceLineVariant({ ...scope, cartId: cart.id, lineId: line.id, variantId: resolution.variant.id, quantity: Math.max(quantity, 1) });
    const newLine = updated.lines.find((cartLine) => cartLine.variantId === resolution.variant.id);
    return { added: true, cart: updated, lineId: newLine?.id };
  },
});

export const createCommerceCheckout = defineTool({
  name: "createCommerceCheckout",
  description: "Price the provider cart and create a payment bound to that exact cart snapshot.",
  inputSchema: z.object({ cartId: z.string() }),
  outputSchema: z.object({
    checkoutId: z.string(),
    cartId: z.string(),
    amount: moneySchema,
    snapshotHash: z.string(),
    status: z.literal("pending"),
    paymentRequestId: z.string(),
    checkoutUrl: z.string().optional(),
  }),
  async execute(input, ctx) {
    const checkout = await createCommerceCheckoutCapability({
      graph: ctx.graph,
      customerId: ctx.customerId,
      conversationId: ctx.conversationId,
      cartId: input.cartId,
    });
    const pr = await createPaymentLink({
      graph: ctx.graph,
      businessId: ctx.graph.business.id,
      conversationId: ctx.conversationId,
      customerId: ctx.customerId,
      amount: checkout.cart.total.amount,
      currency: checkout.cart.total.currency,
      reason: `Order for cart ${checkout.cart.id}`,
      binding: {
        kind: "commerce_cart",
        cartId: checkout.cart.id,
        snapshotHash: checkout.snapshotHash,
        amount: checkout.cart.total.amount,
        currency: checkout.cart.total.currency,
      },
    });
    return {
      checkoutId: checkout.checkoutId,
      cartId: checkout.cart.id,
      amount: checkout.cart.total,
      snapshotHash: checkout.snapshotHash,
      status: "pending" as const,
      paymentRequestId: pr.paymentRequestId,
      checkoutUrl: pr.checkoutUrl || checkout.checkoutUrl,
    };
  },
});

export const createCommerceOrder = defineTool({
  name: "createCommerceOrder",
  description: "Create exactly one order, only for a verified payment bound to the unchanged cart.",
  inputSchema: z.object({ cartId: z.string(), paymentRequestId: z.string() }),
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
      paymentRequestId: input.paymentRequestId,
    });
    return { orderId: order.id, cartId: order.cartId, status: "paid" as const, total: order.total, verifiedAt: order.verifiedAt };
  },
});

export const verifyPayment = defineTool({
  name: "verifyPayment",
  description: "Ask the trusted payment provider whether a payment request was paid. Customer claims never set paid state.",
  inputSchema: z.object({ paymentRequestId: z.string() }),
  outputSchema: z.object({
    paymentRequestId: z.string(),
    status: z.enum(["pending", "paid", "failed", "cancelled"]),
    verifiedAt: z.string().optional(),
  }),
  async execute(input, ctx) {
    return verifyPaymentWithProvider({
      paymentRequestId: input.paymentRequestId,
      businessId: ctx.graph.business.id,
      conversationId: ctx.conversationId,
    });
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
