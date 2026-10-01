import type { CommerceOrderRecord, PaymentRequestRecord } from "@/lib/store/types";
import { isSimulatedPayment, isVerifiedPaid, type Money } from "@/lib/owner/revenue";
import type { CostEvidence } from "./impact";

/**
 * MARGIN OBSERVABILITY — explainable margin ONLY where trusted revenue (a provider-verified payment
 * for the order) and trusted cost (verified evidence attached to that order) both exist. Missing cost
 * is never guessed: such orders are counted as "revenue with unknown cost", apart.
 */

export type OrderMargin = { orderId: string; conversationId: string; currency: string; revenue: number; cost: number | null; margin: number | null; marginPct: number | null; costLines: { kind: CostEvidence["kind"]; amount: number; reference: string }[]; simulated: boolean; explain: string };
export type MarginSummary = { byCurrency: Record<string, { ordersWithKnownCost: number; revenue: number; cost: number; margin: number; marginPct: number | null }>; revenueWithUnknownCost: Money; ordersWithoutCost: number; simulatedOrders: number };

const round = (n: number) => Math.round(n * 100) / 100;

export function marginView(input: { orders: CommerceOrderRecord[]; payments: PaymentRequestRecord[]; evidence: CostEvidence[] }): { orders: OrderMargin[]; summary: MarginSummary } {
  const out: OrderMargin[] = [];
  const summary: MarginSummary = { byCurrency: {}, revenueWithUnknownCost: {}, ordersWithoutCost: 0, simulatedOrders: 0 };
  for (const o of input.orders) {
    const payment = input.payments.find((p) => p.conversationId === o.conversationId && isVerifiedPaid(p) && p.amount === o.totalAmount && p.currency === o.currency) ?? input.payments.find((p) => p.conversationId === o.conversationId && isVerifiedPaid(p));
    if (!payment) continue; // revenue not provider-verified → not revenue
    const simulated = isSimulatedPayment(payment);
    const costs = input.evidence.filter((e) => e.verified && !e.exposure && (e.orderId === o.orderId || e.orderId === o.id) && e.currency === o.currency);
    const cost = costs.length ? round(costs.reduce((s, e) => s + e.amount, 0)) : null;
    const margin = cost === null ? null : round(o.totalAmount - cost);
    const marginPct = margin === null || o.totalAmount === 0 ? null : round((margin / o.totalAmount) * 100);
    out.push({ orderId: o.orderId, conversationId: o.conversationId, currency: o.currency, revenue: o.totalAmount, cost, margin, marginPct, costLines: costs.map((e) => ({ kind: e.kind, amount: e.amount, reference: e.source.reference })), simulated, explain: cost === null ? "Revenue is verified; no verified cost is attached to this order, so the margin is unknown." : `Revenue ${o.totalAmount} ${o.currency} (verified payment ${payment.id.slice(0, 10)}) minus ${costs.length} verified cost line${costs.length === 1 ? "" : "s"} ${cost} = ${margin} (${marginPct}%).` });
    if (simulated) {
      summary.simulatedOrders += 1;
      continue;
    }
    if (cost === null) {
      summary.ordersWithoutCost += 1;
      summary.revenueWithUnknownCost[o.currency] = round((summary.revenueWithUnknownCost[o.currency] ?? 0) + o.totalAmount);
      continue;
    }
    const c = (summary.byCurrency[o.currency] ??= { ordersWithKnownCost: 0, revenue: 0, cost: 0, margin: 0, marginPct: null });
    c.ordersWithKnownCost += 1;
    c.revenue = round(c.revenue + o.totalAmount);
    c.cost = round(c.cost + cost);
    c.margin = round(c.margin + (margin ?? 0));
    c.marginPct = c.revenue ? round((c.margin / c.revenue) * 100) : null;
  }
  return { orders: out, summary };
}
