import { effectiveMonthlyPrice, type CommercialAccount, type CommercialEvent } from "./account";
import { GROSS_MARGIN_TARGET_PCT, PLAN_CATALOG } from "./plans";
import type { CostToServe, Period } from "./cost";

/**
 * UNIT ECONOMICS per business per period (founder only). Recurring and setup economics NEVER mix:
 *   recurring revenue  = the contracted monthly price × the share of the period the subscription was
 *                        PAID-ACTIVE (free-period, paused, cancelled and pre-activation days earn 0);
 *                        CONTRACTED under manual billing — not "collected" (no billing provider).
 *   setup revenue      = the setup fee recorded as paid in this period — reported apart.
 *   gross contribution = recurring revenue − direct recurring cost-to-serve (same currency only; a
 *                        currency mismatch is reported, never silently converted).
 *   gross margin %     = contribution / recurring revenue (none when there is no recurring revenue).
 * A cost above the plan's guardrail creates a founder alert — never an automatic customer shutdown.
 */

export type UnitEconomics = {
  businessId: string;
  period: Period;
  plan: CommercialAccount["plan"] | null;
  currency: string;
  recurringRevenue: number;
  recurringBasis: "contracted" | "none";
  paidDays: number;
  freeDays: number;
  periodDays: number;
  setupRevenue: number;
  costToServe: number | null;
  costComplete: boolean;
  costMissing: string[];
  costBasis: "measured" | "estimated" | "mixed" | "unavailable";
  grossContribution: number | null;
  grossMarginPct: number | null;
  /** Below the internal target (only judged with recurring revenue). */
  belowMarginTarget: boolean;
  guardrail: number | null;
  /** Monthly-normalised cost above the plan's guardrail. */
  aboveGuardrail: boolean;
  /** Setup fee minus the cost of the free days in this period (does setup cover the free month?). */
  freePeriodCoverage: number | null;
  notes: string[];
};

const DAY = 24 * 3600_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

function daysIn(p: Period): number {
  return Math.round((Date.parse(p.end) - Date.parse(p.start)) / DAY);
}

/** Overlap in days of [a,b) with the period. */
function overlapDays(a: string | null, b: string | null, p: Period): number {
  if (!a) return 0;
  const start = Math.max(Date.parse(a), Date.parse(p.start));
  const end = Math.min(b ? Date.parse(b) : Date.parse(p.end), Date.parse(p.end));
  return Math.max(0, (end - start) / DAY);
}

export function unitEconomics(input: { account: CommercialAccount | null; events: CommercialEvent[]; cost: CostToServe; now?: Date }): UnitEconomics {
  const { account, cost } = input;
  const period = cost.period;
  const periodDays = daysIn(period);
  const notes: string[] = [];
  const currency = account?.currency ?? "USD";
  let paidDays = 0;
  let freeDays = 0;
  if (account) {
    const cancelAt = account.cancellationEffectiveAt;
    const recurringFrom = account.recurringConfirmedAt ? account.recurringStartsAt : null;
    // Free days: from free start to free end (or recurring start / cancellation, whichever first).
    const freeEnd = [account.freePeriodEndsAt, cancelAt].filter(Boolean).sort()[0] ?? null;
    freeDays = overlapDays(account.freePeriodStartsAt, freeEnd, period);
    // Paid days: from confirmed recurring start until cancellation; a pause right now stops the clock.
    const paidEnd = [cancelAt, account.subscriptionState === "paused" ? account.pausedAt : null].filter(Boolean).sort()[0] ?? null;
    paidDays = overlapDays(recurringFrom, paidEnd, period);
  } else {
    notes.push("No commercial account: no plan, no revenue.");
  }
  const monthly = account ? effectiveMonthlyPrice(account, input.now) : 0;
  const recurringRevenue = r2((monthly * paidDays) / periodDays);
  if (account?.foundingCustomer && account.lockedMonthlyPrice !== null && monthly === account.lockedMonthlyPrice) notes.push(`Founding price lock: ${account.lockedMonthlyPrice} ${currency}/month until ${account.priceLockUntil?.slice(0, 10)}.`);
  if (freeDays > 0) notes.push(`${Math.round(freeDays)} free-period day(s) in this period earn no recurring revenue.`);

  const setupPaid = input.events.filter((e) => (e.kind === "setup_paid") && e.at >= period.start && e.at < period.end);
  const setupRevenue = account && setupPaid.length ? (account.setupPrice ?? 0) : 0;

  const costInCurrency = cost.total[currency];
  const otherCurrencies = Object.keys(cost.total).filter((c) => c !== currency);
  if (otherCurrencies.length) notes.push(`Costs in ${otherCurrencies.join(", ")} are not converted into ${currency}; contribution covers ${currency} costs only.`);
  const known = cost.lines.filter((l) => l.amount !== null);
  const costBasis: UnitEconomics["costBasis"] = known.length === 0 ? "unavailable" : known.every((l) => l.basis === "measured") ? "measured" : known.every((l) => l.basis === "estimated") ? "estimated" : "mixed";
  const costToServe = costInCurrency ?? (known.length ? 0 : null);
  if (cost.missing.length) notes.push(`Cost is a lower bound: no data for ${cost.missing.length} categor${cost.missing.length === 1 ? "y" : "ies"}.`);

  const grossContribution = costToServe === null ? null : r2(recurringRevenue - costToServe);
  const grossMarginPct = grossContribution !== null && recurringRevenue > 0 ? Math.round((grossContribution / recurringRevenue) * 1000) / 10 : null;
  const guardrail = account ? PLAN_CATALOG[account.plan].costGuardrail : null;
  const monthlyCost = costToServe === null ? null : (costToServe * 30) / Math.max(1, Math.min(periodDays, elapsedDays(period, input.now)));
  const aboveGuardrail = guardrail !== null && monthlyCost !== null && currency === "USD" && monthlyCost > guardrail;
  if (aboveGuardrail) notes.push(`Cost-to-serve runs at ~${r2(monthlyCost!)} USD/month, above the ${guardrail} USD guardrail for ${account ? PLAN_CATALOG[account.plan].name : "this plan"}.`);
  const freeCost = costToServe !== null && freeDays > 0 ? (costToServe * freeDays) / Math.max(1, freeDays + paidDays) : null;
  const freePeriodCoverage = account?.setupPrice !== null && account?.setupPrice !== undefined && freeCost !== null && (account.setupStatus === "paid") ? r2(account.setupPrice - freeCost) : null;

  return {
    businessId: account?.businessId ?? "",
    period,
    plan: account?.plan ?? null,
    currency,
    recurringRevenue,
    recurringBasis: paidDays > 0 ? "contracted" : "none",
    paidDays: Math.round(paidDays * 10) / 10,
    freeDays: Math.round(freeDays * 10) / 10,
    periodDays,
    setupRevenue,
    costToServe,
    costComplete: cost.missing.length === 0,
    costMissing: cost.missing,
    costBasis,
    grossContribution,
    grossMarginPct,
    belowMarginTarget: grossMarginPct !== null && grossMarginPct < GROSS_MARGIN_TARGET_PCT,
    guardrail,
    aboveGuardrail,
    freePeriodCoverage,
    notes,
  };
}

/** Days of the period elapsed by `now` (a running month is normalised by what has passed). */
function elapsedDays(p: Period, now = new Date()): number {
  const end = Math.min(now.getTime(), Date.parse(p.end));
  return Math.max(1, (end - Date.parse(p.start)) / DAY);
}
