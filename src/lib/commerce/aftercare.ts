import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import type { LearnedFactRecord } from "@/lib/store/types";
import { resolveCommerceAdapterForBusiness } from "./registry";
import type { Order } from "./types";

/**
 * ORDER AFTERCARE — provider-grounded order status, pickup / shipping status, the business's own
 * returns / exchange policy (owner-approved facts only) and the next SUPPORTED action. Nothing here is
 * inferred: if the provider does not expose a status, BARRY says so; if no policy fact is approved,
 * BARRY offers to hand the question to a person.
 */

export type OrderStatusView = { status: string; fulfillment?: "pickup" | "shipping" | "unknown"; trackingNumber?: string; eta?: string; updatedAt?: string };
export type AftercareNextAction = "track_shipment" | "arrange_pickup" | "start_return" | "ask_team";

export type Aftercare = {
  order: { id: string; providerOrderId?: string; status: Order["status"]; total: Order["total"]; lines: number; verifiedAt: string } | null;
  providerStatus: OrderStatusView | null;
  returns: { policy: string; source: "owner_approved_fact" } | { policy: null; source: "not_known" };
  shipping: { policy: string; source: "owner_approved_fact" } | { policy: null; source: "not_known" };
  nextActions: AftercareNextAction[];
  words: string;
};

const approved = (f: LearnedFactRecord) => f.ownerVerified && (f.status === "verified" || f.status === "corrected");

export async function orderAftercare(graph: BusinessGraph, orderId: string, opts: { facts?: LearnedFactRecord[]; lang?: string } = {}): Promise<Aftercare> {
  const businessId = graph.business.id;
  const facts = opts.facts ?? (await getBackend().listLearnedFacts(businessId));
  const fact = (keys: string[]) => facts.find((f) => keys.includes(f.key) && approved(f));
  const returnsFact = fact(["policy.returns", "policy.exchanges"]);
  const shippingFact = fact(["policy.shipping", "policy.delivery_time"]);
  let order: Order | undefined;
  let providerStatus: OrderStatusView | null = null;
  try {
    const adapter = await resolveCommerceAdapterForBusiness(businessId);
    const stored = (await getBackend().listCommerceOrders(businessId)).find((o) => o.orderId === orderId || o.id === orderId);
    order = (await adapter.getOrder(stored?.orderId ?? orderId)) ?? (stored?.data as Order | undefined);
    if (order && adapter.getOrderStatus) providerStatus = (await adapter.getOrderStatus(order.id)) ?? (order.providerOrderId ? await adapter.getOrderStatus(order.providerOrderId) : undefined) ?? null;
  } catch {
    order = undefined;
  }
  const nextActions: AftercareNextAction[] = [];
  if (providerStatus?.trackingNumber || providerStatus?.fulfillment === "shipping") nextActions.push("track_shipment");
  if (providerStatus?.fulfillment === "pickup") nextActions.push("arrange_pickup");
  if (order && returnsFact) nextActions.push("start_return");
  if (!order || !returnsFact) nextActions.push("ask_team");
  const he = (opts.lang ?? graph.business.locale).startsWith("he");
  const words = !order
    ? he ? "לא מצאתי הזמנה כזו ברשומות; הצוות יוכל לבדוק." : "I couldn't find that order in the records; the team can check it."
    : [
        he ? `ההזמנה ${order.providerOrderId ?? order.id}: ${providerStatus?.status ?? order.status}` : `Order ${order.providerOrderId ?? order.id}: ${providerStatus?.status ?? order.status}`,
        providerStatus?.eta ? (he ? `צפי: ${providerStatus.eta}` : `expected ${providerStatus.eta}`) : "",
        providerStatus?.trackingNumber ? (he ? `מעקב: ${providerStatus.trackingNumber}` : `tracking ${providerStatus.trackingNumber}`) : "",
        returnsFact ? (he ? `החזרות: ${returnsFact.value}` : `Returns: ${returnsFact.value}`) : he ? "לגבי החזרות — אעביר לצוות." : "For returns, I'll hand you to the team.",
      ].filter(Boolean).join(" · ");
  return {
    order: order ? { id: order.id, providerOrderId: order.providerOrderId, status: order.status, total: order.total, lines: order.lines.length, verifiedAt: order.verifiedAt } : null,
    providerStatus,
    returns: returnsFact ? { policy: returnsFact.value, source: "owner_approved_fact" } : { policy: null, source: "not_known" },
    shipping: shippingFact ? { policy: shippingFact.value, source: "owner_approved_fact" } : { policy: null, source: "not_known" },
    nextActions,
    words,
  };
}
