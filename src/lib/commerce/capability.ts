import crypto from "node:crypto";
import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import type { PaymentRequestRecord } from "@/lib/store";
import { resolveCommerceAdapterForBusiness } from "./registry";
import { groundSearchQuery, type CatalogSchema, type SearchRequest } from "./catalog";
import type { Cart, CommerceAdapter, Money, Order, Product, ProductVariant } from "./types";

/**
 * Commerce capability. Two rules hold everywhere in this module:
 *
 * 1. The PROVIDER's cart is the source of truth. BARRY keeps only a
 *    pointer (cart id) plus an audit snapshot; every read that matters
 *    re-fetches from the provider, and every change executes there.
 * 2. Money is bound to an exact cart snapshot. A payment created at
 *    checkout carries the snapshot hash it was priced from; an order is
 *    only created when the provider's cart still hashes to that value
 *    and the verified payment amount/currency still equal its total.
 */

type Ctx = { graph: BusinessGraph; customerId: string; conversationId: string };

export class CommerceError extends Error {}

const SCHEMA_TTL_MS = 5 * 60 * 1000;
const schemaCache = new Map<string, { schema: CatalogSchema; at: number; adapter: CommerceAdapter }>();

/** The provider's searchable catalog schema, cached briefly per business (and per adapter instance). */
export async function getCatalogSchema(graph: BusinessGraph): Promise<CatalogSchema> {
  const adapter = await resolveCommerceAdapterForBusiness(graph.business.id);
  const cached = schemaCache.get(graph.business.id);
  if (cached && cached.adapter === adapter && Date.now() - cached.at < SCHEMA_TTL_MS) return cached.schema;
  const schema = await adapter.describeCatalog();
  schemaCache.set(graph.business.id, { schema, at: Date.now(), adapter });
  return schema;
}

/**
 * Search through the provider. The query is re-grounded against the
 * provider's own schema first, whoever the caller is: the provider only
 * ever receives fields its catalog actually has.
 */
export async function searchCommerceProducts(graph: BusinessGraph, query: SearchRequest) {
  const adapter = await resolveCommerceAdapterForBusiness(graph.business.id);
  const schema = await getCatalogSchema(graph);
  const grounded = groundSearchQuery(schema, query);
  const result = await adapter.searchProducts(grounded.query);
  return { ...result, query: grounded.query, dropped: grounded.rejected };
}

export async function getCommerceProduct(graph: BusinessGraph, productId: string) {
  const adapter = await resolveCommerceAdapterForBusiness(graph.business.id);
  return adapter.getProduct(productId);
}

/** Deterministic fingerprint of exactly what would be charged for. */
export function cartSnapshotHash(cart: Pick<Cart, "id" | "lines" | "total">): string {
  const canonical = {
    cartId: cart.id,
    lines: [...cart.lines]
      .map((l) => ({ p: l.productId, v: l.variantId, q: l.quantity, a: l.unitPrice.amount, c: l.unitPrice.currency.toUpperCase() }))
      .sort((a, b) => (a.v === b.v ? a.q - b.q : a.v < b.v ? -1 : 1)),
    total: { a: Math.round(cart.total.amount * 100), c: cart.total.currency.toUpperCase() },
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function optionsMatch(variant: ProductVariant, options: Record<string, string> | undefined): boolean {
  return Object.entries(options ?? {}).every(([key, value]) => {
    const actualKey = Object.keys(variant.options).find((k) => k.toLowerCase() === key.toLowerCase());
    return actualKey !== undefined && variant.options[actualKey].toLowerCase() === value.toLowerCase();
  });
}

export type VariantResolution =
  | { ok: true; variant: ProductVariant }
  | { ok: false; reason: "unavailable" | "needs_variant" | "unknown_option"; availableOptions: Record<string, string>[] };

/**
 * Resolve the customer's requested options against REAL variants. Never
 * substitutes a different variant than requested: an unavailable choice
 * is reported back with the real in-stock alternatives, and the customer
 * decides.
 */
export function resolveVariant(product: Product, options: Record<string, string> | undefined, quantity: number): VariantResolution {
  const inStock = product.variants.filter((v) => v.inventory.available >= quantity);
  const availableOptions = inStock.map((v) => v.options);
  const matching = product.variants.filter((v) => optionsMatch(v, options));
  if (options && Object.keys(options).length > 0 && matching.length === 0) {
    return { ok: false, reason: "unknown_option", availableOptions };
  }
  const matchingInStock = matching.filter((v) => v.inventory.available >= quantity);
  if (matchingInStock.length === 0) return { ok: false, reason: "unavailable", availableOptions };
  if (matchingInStock.length > 1) {
    const distinct = new Set(matchingInStock.map((v) => JSON.stringify(v.options)));
    if (distinct.size > 1) return { ok: false, reason: "needs_variant", availableOptions: matchingInStock.map((v) => v.options) };
  }
  return { ok: true, variant: matchingInStock[0] };
}

/** BARRY's durable record of a cart: the last post-effect state, with its revision. */
async function durableCart(ctx: Ctx, cartId: string): Promise<Cart | undefined> {
  const record = (await getBackend().listCommerceCarts(ctx.graph.business.id)).find((r) => r.cartId === cartId && r.conversationId === ctx.conversationId);
  return record?.data as Cart | undefined;
}

/**
 * Persist the provider's post-effect cart as the authoritative current state, with its REVISION: the
 * provider's own, or (for a provider that doesn't version carts) one more than the last recorded
 * revision whenever the cart's content changed.
 */
async function recordCartSnapshot(ctx: Ctx, cart: Cart): Promise<Cart> {
  const previous = await durableCart(ctx, cart.id);
  const revision = cart.revision ?? (previous?.revision ?? 0) + (previous && cartSnapshotHash(previous) === cartSnapshotHash(cart) && previous.status === cart.status ? 0 : 1);
  const stored: Cart = { ...cart, revision };
  await getBackend().upsertCommerceCart({
    businessId: ctx.graph.business.id,
    conversationId: ctx.conversationId,
    customerId: ctx.customerId,
    cartId: cart.id,
    status: cart.status,
    data: stored,
  });
  return stored;
}

export class StaleCartError extends Error {}

/**
 * THE authoritative current cart. A process-local simulated provider that doesn't hold the cart (a
 * different serverless instance, a cold start) or holds an older revision is first reinstated from
 * BARRY's durable snapshot — so every reader in every process sees the same cart revision. A provider
 * read OLDER than the recorded revision is stale and refused: nothing is built on it.
 */
async function currentCart(adapter: CommerceAdapter, ctx: Ctx, cartId: string): Promise<Cart | undefined> {
  let cart = await adapter.getCart(cartId);
  const durable = await durableCart(ctx, cartId);
  if (durable && adapter.restoreCart && (!cart || (cart.revision ?? 0) < (durable.revision ?? 0))) {
    await adapter.restoreCart(durable);
    cart = await adapter.getCart(cartId);
  }
  if (cart && durable?.revision !== undefined && cart.revision !== undefined && cart.revision < durable.revision) {
    throw new StaleCartError(`Cart read is stale (revision ${cart.revision} < ${durable.revision})`);
  }
  if (cart && cart.revision === undefined && durable?.revision !== undefined && cartSnapshotHash(cart) === cartSnapshotHash(durable)) cart = { ...cart, revision: durable.revision };
  return cart;
}

/** Fetch the provider's cart and prove it belongs to this business + conversation. */
async function ownedProviderCart(adapter: CommerceAdapter, ctx: Ctx, cartId: string): Promise<Cart> {
  const cart = await currentCart(adapter, ctx, cartId);
  if (!cart) throw new CommerceError("Cart not found");
  if (cart.businessId !== ctx.graph.business.id || cart.conversationId !== ctx.conversationId) {
    throw new CommerceError("Cart does not belong to this conversation");
  }
  return cart;
}

export async function getOwnedCart(ctx: Ctx, cartId: string): Promise<Cart> {
  const adapter = await resolveCommerceAdapterForBusiness(ctx.graph.business.id);
  return ownedProviderCart(adapter, ctx, cartId);
}

async function ensureProviderCart(adapter: CommerceAdapter, ctx: Ctx): Promise<Cart> {
  const records = await getBackend().listCommerceCarts(ctx.graph.business.id);
  const pointer = records.find((r) => r.conversationId === ctx.conversationId && r.status !== "ordered");
  if (pointer) {
    const live = await currentCart(adapter, ctx, pointer.cartId);
    if (live && live.status !== "ordered") return live;
  }
  const cart = await adapter.createCart({ businessId: ctx.graph.business.id, customerId: ctx.customerId, conversationId: ctx.conversationId });
  return recordCartSnapshot(ctx, cart);
}

export async function addCommerceItem(ctx: Ctx & { productId: string; variantId: string; quantity: number }): Promise<Cart> {
  const adapter = await resolveCommerceAdapterForBusiness(ctx.graph.business.id);
  const cart = await ensureProviderCart(adapter, ctx);
  const updated = await adapter.addToCart({ cartId: cart.id, productId: ctx.productId, variantId: ctx.variantId, quantity: ctx.quantity });
  return recordCartSnapshot(ctx, updated);
}

export async function setCommerceLineQuantity(ctx: Ctx & { cartId: string; lineId: string; quantity: number }): Promise<Cart> {
  const adapter = await resolveCommerceAdapterForBusiness(ctx.graph.business.id);
  const cart = await ownedProviderCart(adapter, ctx, ctx.cartId);
  if (!cart.lines.some((l) => l.id === ctx.lineId)) throw new CommerceError("Cart line not found");
  const updated = await adapter.updateQuantity({ cartId: cart.id, lineId: ctx.lineId, quantity: ctx.quantity });
  return recordCartSnapshot(ctx, updated);
}

/**
 * Swap a line to a different variant ON THE PROVIDER: add the new
 * variant first, then remove the old line — if the add fails, the
 * customer's existing line is untouched.
 */
export async function replaceCommerceLineVariant(ctx: Ctx & { cartId: string; lineId: string; variantId: string; quantity: number }): Promise<Cart> {
  const adapter = await resolveCommerceAdapterForBusiness(ctx.graph.business.id);
  const cart = await ownedProviderCart(adapter, ctx, ctx.cartId);
  const line = cart.lines.find((l) => l.id === ctx.lineId);
  if (!line) throw new CommerceError("Cart line not found");
  if (line.variantId === ctx.variantId) {
    return line.quantity === ctx.quantity ? cart : setCommerceLineQuantity({ ...ctx, quantity: ctx.quantity });
  }
  const withNew = await adapter.addToCart({ cartId: cart.id, productId: line.productId, variantId: ctx.variantId, quantity: ctx.quantity });
  const updated = await adapter.updateQuantity({ cartId: withNew.id, lineId: line.id, quantity: 0 });
  return recordCartSnapshot(ctx, updated);
}

export type CommerceCheckoutResult = {
  checkoutId: string;
  cart: Cart;
  snapshotHash: string;
  checkoutUrl?: string;
};

export async function createCommerceCheckout(ctx: Ctx & { cartId: string }): Promise<CommerceCheckoutResult> {
  const adapter = await resolveCommerceAdapterForBusiness(ctx.graph.business.id);
  const cart = await ownedProviderCart(adapter, ctx, ctx.cartId);
  if (cart.lines.length === 0) throw new CommerceError("Cart is empty");
  const checkout = await adapter.createCheckout({ cartId: cart.id });
  if (
    Math.round(checkout.amount.amount * 100) !== Math.round(cart.total.amount * 100) ||
    checkout.amount.currency.toUpperCase() !== cart.total.currency.toUpperCase()
  ) {
    throw new CommerceError("Checkout total does not match cart");
  }
  // The checkout is priced from THIS cart revision; the recorded post-checkout state is the provider's own.
  const priced = await recordCartSnapshot(ctx, { ...((await adapter.getCart(cart.id)) ?? cart), status: "checkout" as const });
  return { checkoutId: checkout.id, cart: priced, snapshotHash: cartSnapshotHash(cart), checkoutUrl: checkout.checkoutUrl };
}

/**
 * A granted discount priced against the cart AS IT IS NOW: the percentage applies to the lines the
 * granted item names (all lines for "the whole cart"), never to anything added since. Exact money.
 */
export function discountedCartTotal(cart: Pick<Cart, "lines" | "total">, discount: { pct: number; item: string }): { before: Money; after: Money; discountable: number } {
  const wholeCart = discount.item === "the whole cart";
  const words = (t: string) => (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 || /\p{N}/u.test(w));
  const wanted = words(discount.item);
  const named = (title: string) => {
    const have = new Set(words(title));
    return wanted.length > 0 && wanted.every((w) => have.has(w));
  };
  const discountable = cart.lines.filter((l) => wholeCart || named(l.title)).reduce((sum, l) => sum + l.unitPrice.amount * l.quantity, 0);
  const off = Math.round(discountable * discount.pct) / 100;
  const after = Math.max(0, Math.round((cart.total.amount - off) * 100) / 100);
  return { before: cart.total, after: { amount: after, currency: cart.total.currency }, discountable };
}

export function commerceOrderIdempotencyKey(input: { businessId: string; conversationId: string; cartId: string; paymentRequestId: string }): string {
  return [input.businessId, input.conversationId, input.cartId, input.paymentRequestId, "order"].join(":");
}

/**
 * The ONLY path to an order. Re-verifies, immediately before creating it:
 * the payment is verified-paid, bound to THIS cart, and the provider's
 * cart still hashes to the snapshot that payment was priced from, with
 * the same amount and currency. The provider re-checks inventory.
 */
export async function createCommerceOrder(ctx: Ctx & { cartId: string; paymentRequestId: string }): Promise<Order> {
  const backend = getBackend();
  const idempotencyKey = commerceOrderIdempotencyKey({
    businessId: ctx.graph.business.id,
    conversationId: ctx.conversationId,
    cartId: ctx.cartId,
    paymentRequestId: ctx.paymentRequestId,
  });
  const existing = (await backend.listCommerceOrders(ctx.graph.business.id)).find((order) => order.idempotencyKey === idempotencyKey);
  if (existing) return existing.data as Order;

  const payment = await backend.getPaymentRequest(ctx.paymentRequestId);
  assertPaymentCoversCart(payment, ctx);

  const adapter = await resolveCommerceAdapterForBusiness(ctx.graph.business.id);
  const cart = await ownedProviderCart(adapter, ctx, ctx.cartId);
  const binding = payment!.binding!;
  if (cartSnapshotHash(cart) !== binding.snapshotHash) throw new CommerceError("Cart changed after payment");
  if (
    Math.round(cart.total.amount * 100) !== Math.round(payment!.amount * 100) ||
    cart.total.currency.toUpperCase() !== payment!.currency.toUpperCase()
  ) {
    throw new CommerceError("Cart changed after payment");
  }

  const order = await adapter.createOrder({ cartId: ctx.cartId, idempotencyKey });
  await backend.createCommerceOrder({
    businessId: ctx.graph.business.id,
    conversationId: ctx.conversationId,
    customerId: ctx.customerId,
    orderId: order.id,
    cartId: order.cartId,
    totalAmount: order.total.amount,
    currency: order.total.currency,
    status: order.status,
    idempotencyKey,
    verifiedAt: order.verifiedAt,
    data: order,
  });
  return order;
}

function assertPaymentCoversCart(payment: PaymentRequestRecord | undefined, ctx: Ctx & { cartId: string }): void {
  if (!payment) throw new CommerceError("Payment not found");
  if (payment.businessId !== ctx.graph.business.id || payment.conversationId !== ctx.conversationId) {
    throw new CommerceError("Payment does not belong to this conversation");
  }
  if (payment.status !== "paid") throw new CommerceError("Payment is not verified");
  if (payment.binding?.kind !== "commerce_cart" || payment.binding.cartId !== ctx.cartId) {
    throw new CommerceError("Payment is not bound to this cart");
  }
}
