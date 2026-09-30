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
  return out;
}

/** The semantic guard every surface must use: an estimate is never shown as realised. */
export function isRealized(o: ProfitOpportunity): boolean {
  return o.state === "REALIZED" && !!o.realized && o.realized.evidence.length > 0;
}
