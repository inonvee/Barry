import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { resolveCommerceAdapterForBusiness } from "./registry";
import type { Cart, Order, ProductSearchQuery } from "./types";

export async function searchCommerceProducts(graph: BusinessGraph, query: ProductSearchQuery) {
  return resolveCommerceAdapterForBusiness(graph.business.id).then((adapter) => adapter.searchProducts(query));
}

export async function getCommerceProduct(graph: BusinessGraph, productId: string) {
  const adapter = await resolveCommerceAdapterForBusiness(graph.business.id);
  return adapter.getProduct(productId);
}

export async function ensureCommerceCart(input: { graph: BusinessGraph; customerId: string; conversationId: string }): Promise<Cart> {
  const backend = getBackend();
  const existing = (await backend.listCommerceCarts(input.graph.business.id)).find((cart) => cart.conversationId === input.conversationId && cart.status !== "ordered");
  if (existing) return existing.data as Cart;
  const adapter = await resolveCommerceAdapterForBusiness(input.graph.business.id);
  const cart = await adapter.createCart({ businessId: input.graph.business.id, customerId: input.customerId, conversationId: input.conversationId });
  await backend.upsertCommerceCart({ businessId: input.graph.business.id, conversationId: input.conversationId, customerId: input.customerId, cartId: cart.id, status: cart.status, data: cart });
  return cart;
}

export async function addCommerceItem(input: { graph: BusinessGraph; customerId: string; conversationId: string; productId: string; variantId: string; quantity: number }) {
  const adapter = await resolveCommerceAdapterForBusiness(input.graph.business.id);
  const cart = await ensureCommerceCart(input);
  const updated = await adapter.addToCart({ cartId: cart.id, productId: input.productId, variantId: input.variantId, quantity: input.quantity });
  await getBackend().upsertCommerceCart({ businessId: input.graph.business.id, conversationId: input.conversationId, customerId: input.customerId, cartId: updated.id, status: updated.status, data: updated });
  return updated;
}

export async function updateCommerceLine(input: { graph: BusinessGraph; customerId: string; conversationId: string; lineId: string; quantity: number }) {
  const adapter = await resolveCommerceAdapterForBusiness(input.graph.business.id);
  const cart = await ensureCommerceCart(input);
  const updated = await adapter.updateQuantity({ cartId: cart.id, lineId: input.lineId, quantity: input.quantity });
  await getBackend().upsertCommerceCart({ businessId: input.graph.business.id, conversationId: input.conversationId, customerId: input.customerId, cartId: updated.id, status: updated.status, data: updated });
  return updated;
}

export async function saveCommerceCart(input: { graph: BusinessGraph; customerId: string; conversationId: string; cart: Cart }) {
  await getBackend().upsertCommerceCart({
    businessId: input.graph.business.id,
    conversationId: input.conversationId,
    customerId: input.customerId,
    cartId: input.cart.id,
    status: input.cart.status,
    data: input.cart,
  });
  return input.cart;
}

export async function createCommerceCheckout(input: { graph: BusinessGraph; customerId: string; conversationId: string }) {
  const adapter = await resolveCommerceAdapterForBusiness(input.graph.business.id);
  const cart = await ensureCommerceCart(input);
  const checkout = await adapter.createCheckout({ cartId: cart.id });
  await getBackend().upsertCommerceCart({ businessId: input.graph.business.id, conversationId: input.conversationId, customerId: input.customerId, cartId: cart.id, status: "checkout", data: { ...cart, status: "checkout" } });
  return checkout;
}

export function commerceOrderIdempotencyKey(input: { businessId: string; conversationId: string; cartId: string }): string {
  return [input.businessId, input.conversationId, input.cartId, "order"].join(":");
}

export async function createCommerceOrder(input: { graph: BusinessGraph; customerId: string; conversationId: string; cartId: string; idempotencyKey: string }): Promise<Order> {
  const existing = (await getBackend().listCommerceOrders(input.graph.business.id)).find((order) => order.idempotencyKey === input.idempotencyKey);
  if (existing) return existing.data as Order;
  const adapter = await resolveCommerceAdapterForBusiness(input.graph.business.id);
  const order = await adapter.createOrder({ cartId: input.cartId, idempotencyKey: input.idempotencyKey });
  await getBackend().createCommerceOrder({
    businessId: input.graph.business.id,
    conversationId: input.conversationId,
    customerId: input.customerId,
    orderId: order.id,
    cartId: order.cartId,
    totalAmount: order.total.amount,
    currency: order.total.currency,
    status: order.status,
    idempotencyKey: input.idempotencyKey,
    verifiedAt: order.verifiedAt,
    data: order,
  });
  return order;
}
