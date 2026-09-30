import type { BusinessGraph, Offer } from "@/lib/business-graph";
import { getPolicy } from "@/lib/business-graph/queries";

/**
 * THE authoritative money object for a transaction.
 *
 * Every amount BARRY states, proposes for approval, charges or records comes from a Quote computed
 * here — from the Genome's own prices, the quantity, the discount and the business's own shipping
 * rules — never from composer arithmetic and never from a unit price when the customer asked for
 * several. The same Quote is carried in conversation state, the approval payload (so the owner
 * reviews exactly what would be charged), the payment request, receipts and the reply context.
 *
 * Shipping is only ever what the business's rules say: free above its threshold, its flat fee,
 * or UNKNOWN — an unknown fee is never invented and the total is then marked incomplete.
 */

export type QuoteLine = { item: string; itemRef: string; unitPrice: number; quantity: number; lineTotal: number };

export type Quote = {
  currency: string;
  lines: QuoteLine[];
  /** Sum of lines before discount. */
  subtotal: number;
  discountPct: number;
  discount: number;
  /** Goods after discount. */
  goodsTotal: number;
  shipping: { amount: number | null; basis: "free_above_threshold" | "flat_fee" | "unknown" | "not_applicable"; threshold?: number };
  /** Goods + shipping when shipping is known; goods only (and complete=false) when it isn't. */
  total: number;
  complete: boolean;
};

export const round2 = (n: number) => Math.round(n * 100) / 100;

function shippingFor(graph: BusinessGraph, goodsTotal: number, physical: boolean): Quote["shipping"] {
  if (!physical) return { amount: 0, basis: "not_applicable" };
  const threshold = getPolicy(graph, "free_shipping_over")?.value;
  const flat = getPolicy(graph, "flat_shipping_fee")?.value;
  // "Free shipping over X": strictly above the threshold.
  if (threshold !== undefined && goodsTotal > threshold) return { amount: 0, basis: "free_above_threshold", threshold };
  if (flat !== undefined) return { amount: flat, basis: "flat_fee", ...(threshold !== undefined ? { threshold } : {}) };
  return { amount: null, basis: "unknown", ...(threshold !== undefined ? { threshold } : {}) };
}

export function buildQuote(
  graph: BusinessGraph,
  lines: { item: string; itemRef: string; unitPrice: number; quantity: number }[],
  currency: string,
  discountPct = 0,
  physical = true
): Quote {
  const qLines = lines.map((l) => ({ ...l, quantity: Math.max(1, Math.floor(l.quantity)), lineTotal: round2(l.unitPrice * Math.max(1, Math.floor(l.quantity))) }));
  const subtotal = round2(qLines.reduce((a, l) => a + l.lineTotal, 0));
  const pct = Math.min(100, Math.max(0, discountPct));
  const discount = round2((subtotal * pct) / 100);
  const goodsTotal = round2(subtotal - discount);
  const shipping = shippingFor(graph, goodsTotal, physical);
  return {
    currency,
    lines: qLines,
    subtotal,
    discountPct: pct,
    discount,
    goodsTotal,
    shipping,
    total: round2(goodsTotal + (shipping.amount ?? 0)),
    complete: shipping.amount !== null,
  };
}

/** A quote for N units of one offer (a purchase), or its deposit (a booking deposit is per booking). */
export function quoteOffer(graph: BusinessGraph, offer: Offer, quantity: number, discountPct: number, kind: "purchase" | "deposit" = "purchase"): Quote | undefined {
  if (kind === "deposit") {
    const deposit = offer.depositAmount ?? offer.price;
    if (deposit === null || deposit === undefined) return undefined;
    return buildQuote(graph, [{ item: `${offer.name} (deposit)`, itemRef: offer.id, unitPrice: deposit, quantity: 1 }], offer.currency, discountPct, false);
  }
  if (offer.price === null) return undefined;
  return buildQuote(graph, [{ item: offer.name, itemRef: offer.id, unitPrice: offer.price, quantity }], offer.currency, discountPct, offer.requiresInventory);
}

/** The terms of a payment derived from a quote — the ONE payload shape for approval, execution and receipts. */
export function paymentTermsFromQuote(quote: Quote, reason: string) {
  return {
    amount: quote.total,
    currency: quote.currency,
    reason,
    discountPct: quote.discountPct,
    isCustomPrice: false,
    quantity: quote.lines.reduce((a, l) => a + l.quantity, 0),
    lines: quote.lines.map((l) => ({ item: l.item, itemRef: l.itemRef, unitPrice: l.unitPrice, quantity: l.quantity })),
    shipping: quote.shipping.amount,
  };
}

/** The quote for what the conversation is currently about (selected offer, latest quantity and discount). */
export function currentQuote(graph: BusinessGraph, state: { selectedOfferId?: string | null; knownFields: Record<string, string> }): Quote | undefined {
  const offer = state.selectedOfferId ? graph.offers.find((o) => o.id === state.selectedOfferId) : undefined;
  if (!offer || offer.price === null) return undefined;
  const quantity = Number(state.knownFields.__quantity ?? 1);
  const discountPct = Number(state.knownFields.__discountPct ?? 0);
  return quoteOffer(graph, offer, quantity, discountPct);
}
