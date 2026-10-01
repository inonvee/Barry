import type { Money, RevenueSummary } from "@/lib/owner/revenue";

/**
 * PROFIT / MARGIN OPERATOR — FOUNDATION. BARRY's premium north star is to improve the business while it
 * runs it: optimise profit, not only revenue. This module fixes the SEMANTICS before any connector
 * exists, so nothing estimated can ever be shown as realised:
 *
 *   Financial impact (money BARRY affected):
 *     GENERATED  — collected, provider-verified revenue BARRY produced (the Money page's "collected").
 *     RECOVERED  — collected after a failed / cancelled / blocked attempt (already inside GENERATED).
 *     SAVED      — cost avoided, with the evidence that proves it; REALIZED only.
 *   Savings lifecycle:
 *     POTENTIAL  — evidence shows a cost; nothing proposed yet.
 *     PROPOSED   — BARRY proposed an action to the owner (an obligation / intervention exists).
 *     NEGOTIATED — the counterparty agreed (a record from their system).
 *     REALIZED   — the lower cost is evidenced in a later record.
 *
 * Cost evidence is provider-independent; no connector produces it yet, so `profitOpportunities([])` is
 * empty and every SAVED figure is zero. Nothing here seeds savings outside QA fixtures.
 */

export type FinancialImpactState = "GENERATED" | "RECOVERED" | "SAVED";
export type SavingsState = "POTENTIAL" | "PROPOSED" | "NEGOTIATED" | "REALIZED";

export type CostEvidenceKind = "supplier_cost" | "payment_fee" | "shipping_fulfillment" | "saas_subscription" | "discount" | "return" | "inventory_carrying" | "deposit_no_show" | "other_operating_cost";

/** One cost the business really bore (or is exposed to), from a connected system's record. */
export type CostEvidence = {
  id: string;
  businessId: string;
  kind: CostEvidenceKind;
  amount: number;
  currency: string;
  at: string;
  /** Where it comes from: the system and its own reference (an invoice, a fee line, a return id). */
  source: { system: string; reference: string };
  /** Confirmed by the system that holds it (never inferred). */
  verified: boolean;
  /** For exposures (inventory carrying, deposit / no-show): the exposure window, not a cost already paid. */
  exposure?: boolean;
  note?: string;
  /** Normalized cost model: a category the owner recognises, the counterparty, the item / plan, a unit price and the order it belongs to (when the system states them). */
  category?: string;
  counterparty?: string;
  item?: string;
  unitPrice?: number;
  quantity?: number;
  orderId?: string;
  period?: { start: string; end: string };
};

export type ProfitOpportunity = {
  id: string;
  businessId: string;
  problem: string;
  evidence: CostEvidence[];
  estimatedImpact: { amount: number; currency: string; per: "period" | "month" | "event" };
  /** How sure BARRY is, and exactly what it assumed. */
  confidence: "low" | "medium" | "high";
  assumptions: string[];
  recommendedAction: string;
  authority: "none" | "owner_approval" | "founder";
  state: SavingsState;
  /** Only when the lower cost is evidenced by a later record. */
  realized?: { amount: number; currency: string; evidence: CostEvidence[] };
};

export type FinancialImpact = {
  generated: Money;
  recovered: Money;
  saved: { realized: Money; potential: Money; proposed: Money; negotiated: Money };
  /** Test money (simulated providers) — shown apart, never inside the states above. */
  simulated: Money;
  evidenceCount: number;
};

const add = (m: Money, currency: string, amount: number) => {
  m[currency] = Math.round(((m[currency] ?? 0) + amount) * 100) / 100;
};

/** The impact figures from the one money classification plus any cost evidence. */
export function financialImpact(revenue: RevenueSummary, opportunities: ProfitOpportunity[]): FinancialImpact {
  const saved: FinancialImpact["saved"] = { realized: {}, potential: {}, proposed: {}, negotiated: {} };
  for (const o of opportunities) {
    if (o.state === "REALIZED" && o.realized) add(saved.realized, o.realized.currency, o.realized.amount);
    else if (o.state === "POTENTIAL") add(saved.potential, o.estimatedImpact.currency, o.estimatedImpact.amount);
    else if (o.state === "PROPOSED") add(saved.proposed, o.estimatedImpact.currency, o.estimatedImpact.amount);
    else if (o.state === "NEGOTIATED") add(saved.negotiated, o.estimatedImpact.currency, o.estimatedImpact.amount);
  }
  return {
    generated: { ...revenue.direct },
    recovered: { ...revenue.recovered },
    saved,
    simulated: { ...revenue.simulatedPaid },
    evidenceCount: opportunities.reduce((n, o) => n + o.evidence.length, 0),
  };
}

/**
 * Evidence-backed opportunities. Deterministic rules over VERIFIED cost evidence only; without evidence
 * there are no opportunities (never a seeded "hot" saving). Each rule states its assumptions.
 */
export function profitOpportunities(businessId: string, evidence: CostEvidence[]): ProfitOpportunity[] {
  const verified = evidence.filter((e) => e.businessId === businessId && e.verified && e.amount > 0);
  if (verified.length === 0) return [];
  const out: ProfitOpportunity[] = [];
  const by = (kind: CostEvidenceKind) => verified.filter((e) => e.kind === kind);
  const sum = (xs: CostEvidence[]) => Math.round(xs.reduce((s, e) => s + e.amount, 0) * 100) / 100;
  const currency = (xs: CostEvidence[]) => xs[0]?.currency ?? "USD";

  const fees = by("payment_fee");
  if (fees.length >= 3) {
    out.push({
      id: `payment_fees:${businessId}`,
      businessId,
      problem: `Payment fees of ${sum(fees)} ${currency(fees)} across ${fees.length} verified fee records.`,
      evidence: fees,
      estimatedImpact: { amount: Math.round(sum(fees) * 0.15 * 100) / 100, currency: currency(fees), per: "period" },
      confidence: "low",
      assumptions: ["A renegotiated or alternative provider rate would be ~15% lower — an assumption, not a quote."],
      recommendedAction: "Ask the payment provider for the volume rate, or compare a second provider's fee schedule.",
      authority: "owner_approval",
      state: "POTENTIAL",
    });
  }
  const discounts = by("discount");
  if (discounts.length > 0) {
    out.push({
      id: `discounts:${businessId}`,
      businessId,
      problem: `Discounts granted cost ${sum(discounts)} ${currency(discounts)} (${discounts.length} verified records).`,
      evidence: discounts,
      estimatedImpact: { amount: sum(discounts), currency: currency(discounts), per: "period" },
      confidence: "medium",
      assumptions: ["Every discounted sale would have closed at list price — an upper bound, not a forecast."],
      recommendedAction: "Review the automatic discount limit and which requests you approve.",
      authority: "owner_approval",
      state: "POTENTIAL",
    });
  }
  const returns = by("return");
  if (returns.length >= 2) {
    out.push({
      id: `returns:${businessId}`,
      businessId,
      problem: `Returns cost ${sum(returns)} ${currency(returns)} (${returns.length} verified records).`,
      evidence: returns,
      estimatedImpact: { amount: Math.round(sum(returns) * 0.3 * 100) / 100, currency: currency(returns), per: "period" },
      confidence: "low",
      assumptions: ["Clearer size guidance and stock checks avoid ~30% of returns — an assumption."],
      recommendedAction: "Add size guidance to the catalog facts BARRY quotes; require a stock check before a variant is offered.",
      authority: "none",
      state: "POTENTIAL",
    });
  }
  const exposures = verified.filter((e) => e.exposure && (e.kind === "deposit_no_show" || e.kind === "inventory_carrying"));
  if (exposures.length > 0) {
    out.push({
      id: `exposure:${businessId}`,
      businessId,
      problem: `${sum(exposures)} ${currency(exposures)} exposed (${exposures.map((e) => e.kind.replace(/_/g, " ")).join(", ")}).`,
      evidence: exposures,
      estimatedImpact: { amount: sum(exposures), currency: currency(exposures), per: "event" },
      confidence: "medium",
      assumptions: ["Exposure is the amount at risk, not a cost already paid."],
      recommendedAction: "Collect deposits before the appointment; BARRY's obligations already watch missing deposits.",
      authority: "none",
      state: "POTENTIAL",
    });
  }

  // Supplier price increase: the same supplier item costs more per unit in a later verified record.
  const supplier = by("supplier_cost").filter((e) => e.item && e.unitPrice);
  const byItem = new Map<string, CostEvidence[]>();
  for (const e of supplier) byItem.set(`${e.counterparty ?? "?"}|${e.item}`, [...(byItem.get(`${e.counterparty ?? "?"}|${e.item}`) ?? []), e]);
  for (const [key, xs] of byItem) {
    const sorted = [...xs].sort((a, b) => a.at.localeCompare(b.at));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (sorted.length < 2 || !first.unitPrice || !last.unitPrice || last.unitPrice <= first.unitPrice * 1.05) continue;
    const pct = Math.round(((last.unitPrice - first.unitPrice) / first.unitPrice) * 100);
    const qty = sorted.reduce((n, e) => n + (e.quantity ?? 1), 0);
    out.push({
      id: `supplier_increase:${businessId}:${key}`,
      businessId,
      problem: `${last.counterparty ?? "A supplier"} charges ${pct}% more per unit for ${last.item} than in ${first.at.slice(0, 10)} (${first.unitPrice} → ${last.unitPrice} ${last.currency}).`,
      evidence: sorted,
      estimatedImpact: { amount: Math.round((last.unitPrice - first.unitPrice) * qty * 100) / 100, currency: last.currency, per: "period" },
      confidence: "medium",
      assumptions: ["Volumes stay as recorded; the earlier unit price is attainable again — a negotiation target, not a quote."],
      recommendedAction: "Prepare a negotiation with the purchase history and the earlier price as the target.",
      authority: "owner_approval",
      state: "POTENTIAL",
    });
  }

  // Subscription duplication: two or more subscriptions in the same category.
  const subs = by("saas_subscription");
  const byCategory = new Map<string, CostEvidence[]>();
  for (const e of subs) if (e.category) byCategory.set(e.category.toLowerCase(), [...(byCategory.get(e.category.toLowerCase()) ?? []), e]);
  for (const [category, xs] of byCategory) {
    const distinct = new Set(xs.map((e) => (e.item ?? e.counterparty ?? e.source.reference).toLowerCase()));
    if (distinct.size < 2) continue;
    const cheapest = Math.min(...xs.map((e) => e.amount));
    out.push({
      id: `subscription_duplication:${businessId}:${category}`,
      businessId,
      problem: `${distinct.size} subscriptions in the “${category}” category (${[...distinct].join(", ")}).`,
      evidence: xs,
      estimatedImpact: { amount: Math.round((sum(xs) - cheapest) * 100) / 100, currency: currency(xs), per: "month" },
      confidence: "low",
      assumptions: ["One tool could cover the category — the owner decides which; the saving is everything but the cheapest."],
      recommendedAction: "Review which subscription in this category the business really uses; cancel the rest (owner decision).",
      authority: "owner_approval",
      state: "POTENTIAL",
    });
  }

  // Slow-moving inventory: carrying exposure older than 60 days.
  const slow = by("inventory_carrying").filter((e) => e.exposure && Date.now() - Date.parse(e.at) > 60 * 24 * 3600_000);
  if (slow.length) {
    out.push({
      id: `slow_inventory:${businessId}`,
      businessId,
      problem: `${sum(slow)} ${currency(slow)} of stock has been carried for more than 60 days (${slow.length} record${slow.length === 1 ? "" : "s"}).`,
      evidence: slow,
      estimatedImpact: { amount: sum(slow), currency: currency(slow), per: "period" },
      confidence: "low",
      assumptions: ["The exposure is the stock value, not a realised loss; a promotion or reorder change frees part of it."],
      recommendedAction: "Consider a targeted offer on slow items and a lower reorder cadence (owner decision).",
      authority: "owner_approval",
      state: "POTENTIAL",
    });
  }

  // Shipping inefficiency: per-order shipping cost well above the median.
  const ship = by("shipping_fulfillment").filter((e) => e.orderId);
  if (ship.length >= 4) {
    const amounts = ship.map((e) => e.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const high = ship.filter((e) => e.amount > median * 1.5);
    if (high.length) {
      out.push({
        id: `shipping_inefficiency:${businessId}`,
        businessId,
        problem: `${high.length} of ${ship.length} shipments cost more than 1.5× the median (${median} ${currency(ship)}).`,
        evidence: high,
        estimatedImpact: { amount: Math.round(high.reduce((s, e) => s + (e.amount - median), 0) * 100) / 100, currency: currency(ship), per: "period" },
        confidence: "low",
        assumptions: ["The median rate was attainable for the expensive shipments — an assumption about carrier or packaging choice."],
        recommendedAction: "Check carrier and packaging on the expensive shipments; compare a second carrier's rates.",
        authority: "none",
        state: "POTENTIAL",
      });
    }
  }
  return out;
}

/** The semantic guard every surface must use: an estimate is never shown as realised. */
export function isRealized(o: ProfitOpportunity): boolean {
  return o.state === "REALIZED" && !!o.realized && o.realized.evidence.length > 0;
}
