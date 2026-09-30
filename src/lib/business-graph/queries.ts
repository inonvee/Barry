import type { BusinessGraph, Offer, Policy, Resource } from "./schema";

/** Read-only helpers over a BusinessGraph. No business-type branching allowed here. */

export function findOffer(graph: BusinessGraph, offerId: string): Offer | undefined {
  return graph.offers.find((o) => o.id === offerId);
}

export function offersByKeyword(graph: BusinessGraph, keyword: string): Offer[] {
  const k = keyword.toLowerCase();
  return graph.offers.filter(
    (o) =>
      o.active &&
      (o.name.toLowerCase().includes(k) || o.description.toLowerCase().includes(k))
  );
}

export function resourcesByType(graph: BusinessGraph, type: string): Resource[] {
  return graph.resources.filter((r) => r.type === type);
}

/**
 * Read-only safety actions implied by a capability the business already
 * enabled: any business that can request money can ask its provider
 * whether that money arrived.
 */
const IMPLIED_ACTIONS: Record<string, string[]> = {
  verifyPayment: ["createPaymentRequest", "createCommerceCheckout"],
  // A discount is a term of the payment the business already lets BARRY create; its limit is the discount policy.
  grantDiscount: ["createPaymentRequest", "createCommerceCheckout"],
};

export function isActionAvailable(graph: BusinessGraph, actionName: string): boolean {
  if (graph.availableActions.some((a) => a.name === actionName && a.enabled)) return true;
  return (IMPLIED_ACTIONS[actionName] ?? []).some((base) => graph.availableActions.some((a) => a.name === base && a.enabled));
}

export function getPolicy<T extends Policy["rule"]["type"]>(
  graph: BusinessGraph,
  type: T
): Extract<Policy["rule"], { type: T }> | undefined {
  for (const policy of graph.policies) {
    if (policy.rule.type === type) {
      return policy.rule as Extract<Policy["rule"], { type: T }>;
    }
  }
  return undefined;
}

export function inventoryFor(graph: BusinessGraph, sku: string): number {
  return graph.inventory.find((i) => i.sku === sku)?.quantityOnHand ?? 0;
}

export function knowledgeSearch(graph: BusinessGraph, query: string) {
  const q = query.toLowerCase();
  return graph.knowledge.filter(
    (k) => k.topic.toLowerCase().includes(q) || k.content.toLowerCase().includes(q)
  );
}
