import { commercialStage, freePeriodProgress, type CommercialAccount } from "./account";
import { PLAN_CATALOG } from "./plans";
import type { CostToServe, ModelUsageRecord } from "./cost";
import type { UnitEconomics } from "./economics";
import type { ValueAccount } from "./value";
import type { CommercialReadiness } from "./readiness";

/**
 * FOUNDER-ONLY COMMERCIAL SIGNALS. Each states why, with the numbers behind it. None of them takes an
 * automated billing action or changes what BARRY does for the customer — the founder decides.
 */
export type CommercialAlertKind =
  | "setup_unpaid_while_onboarding"
  | "free_period_ending"
  | "recurring_should_start"
  | "cost_above_guardrail"
  | "unusual_model_usage"
  | "high_support_burden"
  | "low_measurable_value"
  | "intelligence_without_cost_evidence"
  | "operator_capabilities_unavailable"
  | "catalog_changed_for_plan";

export type CommercialAlert = { kind: CommercialAlertKind; severity: "high" | "medium" | "low"; title: string; why: string; nextAction: string };

const DAY = 24 * 3600_000;

export function commercialAlerts(input: {
  account: CommercialAccount | null;
  readiness: CommercialReadiness;
  economics: UnitEconomics;
  cost: CostToServe;
  usage: ModelUsageRecord[];
  value: ValueAccount | null;
  costEvidenceCount: number;
  paidCapabilityGaps: string[];
  now?: Date;
}): CommercialAlert[] {
  const { account: a, readiness, economics, cost, value } = input;
  const now = input.now ?? new Date();
  const out: CommercialAlert[] = [];
  if (!a) return out;
  const stage = commercialStage(a, now);
  const def = PLAN_CATALOG[a.plan];

  const technicalProgress = readiness.items.filter((i) => ["technical", "owner", "supervision"].includes(i.id) && i.ready).length;
  if ((a.setupStatus === "quoted" || a.setupStatus === "invoiced" || a.setupStatus === "not_quoted") && technicalProgress >= 1) {
    out.push({ kind: "setup_unpaid_while_onboarding", severity: "medium", title: "Setup unpaid while onboarding progresses", why: `Setup is ${a.setupStatus.replace(/_/g, " ")}; ${technicalProgress} readiness area(s) are already done.`, nextAction: "Collect (or explicitly waive) the setup fee before the free month." });
  }
  const free = freePeriodProgress(a, now);
  if (stage === "free_month_ending" && free) out.push({ kind: "free_period_ending", severity: "medium", title: `Free month ends in ${free.daysLeft} day(s)`, why: `Day ${free.day} of 30; ends ${free.endsAt.slice(0, 10)}.`, nextAction: "Review the trial summary with the owner." });
  if (stage === "awaiting_recurring") out.push({ kind: "recurring_should_start", severity: "high", title: "Free month is over — confirm the recurring start", why: `The free period ended ${a.freePeriodEndsAt?.slice(0, 10)}; recurring is not confirmed.`, nextAction: "Confirm recurring (manual invoice) or record a pause / cancellation." });
  if (economics.aboveGuardrail) out.push({ kind: "cost_above_guardrail", severity: "high", title: "Cost-to-serve above the plan guardrail", why: `${economics.notes.find((n) => n.startsWith("Cost-to-serve")) ?? "Above guardrail."}`, nextAction: "Check model usage and support time; nothing changes for the customer automatically." });

  // Unusual model usage: the last 24h cost > 3× the trailing daily average (and at least 1 USD), or calls on a model with no rate.
  const t = now.getTime();
  const day = input.usage.filter((u) => Date.parse(u.at) > t - DAY);
  const prior = input.usage.filter((u) => Date.parse(u.at) <= t - DAY && Date.parse(u.at) > t - 15 * DAY);
  const dayCost = day.reduce((s, u) => s + (u.estimatedCostUsd ?? 0), 0);
  const priorDays = prior.length ? Math.max(1, Math.ceil((t - DAY - Math.min(...prior.map((u) => Date.parse(u.at)))) / DAY)) : 0;
  const priorAvg = priorDays ? prior.reduce((s, u) => s + (u.estimatedCostUsd ?? 0), 0) / priorDays : 0;
  if (priorDays >= 3 && dayCost >= 1 && dayCost > 3 * priorAvg) out.push({ kind: "unusual_model_usage", severity: "medium", title: "Unusual model usage", why: `Last 24h ≈ ${dayCost.toFixed(2)} USD vs ≈ ${priorAvg.toFixed(2)} USD/day before (ESTIMATED).`, nextAction: "Open the business's conversations for loops or abuse." });
  if (cost.model.unpricedCalls > 0) out.push({ kind: "unusual_model_usage", severity: "low", title: "Model calls without a cost rate", why: `${cost.model.unpricedCalls} call(s) this period used a model not on ${cost.model.rateCardVersion}; their cost is unavailable.`, nextAction: "Add the model to the rate card (a new version)." });

  const supportLine = cost.lines.find((l) => l.category === "support_time" && l.amount !== null);
  if (supportLine && supportLine.amount! > 0.2 * a.monthlyPrice) out.push({ kind: "high_support_burden", severity: "medium", title: "High human support burden", why: `${cost.supportMinutes} min this period ≈ ${supportLine.amount} USD (ESTIMATED), over 20% of the ${a.monthlyPrice} ${a.currency} price.`, nextAction: "Find what needs a human and fix it in the product or onboarding." });

  const live = a.subscriptionState === "free_period" || a.subscriptionState === "active";
  const since = a.freePeriodStartsAt ? (t - Date.parse(a.freePeriodStartsAt)) / DAY : 0;
  if (live && since >= 14 && value) {
    const made = Object.values(value.made.generated).reduce((s, n) => s + n, 0) + Object.values(value.made.recovered).reduce((s, n) => s + n, 0);
    if (value.handled.conversations < 5 && made === 0) out.push({ kind: "low_measurable_value", severity: "medium", title: "Low measurable value", why: `${Math.floor(since)} days in: ${value.handled.conversations} conversations handled, nothing generated or recovered (verified).`, nextAction: "Check traffic and what BARRY is blocked on before the recurring start." });
  }
  if (a.features.includes("margins") && input.costEvidenceCount === 0) out.push({ kind: "intelligence_without_cost_evidence", severity: a.plan === "INTELLIGENCE" ? "high" : "medium", title: `${def.name} without cost evidence`, why: "BARRY Margins has no connected cost evidence — no savings or margin can be shown (none are fabricated).", nextAction: "Connect or import supplier / fee / shipping / SaaS costs." });
  if (input.paidCapabilityGaps.length && (a.features.includes("commerce_transactions") || a.features.includes("bookings") || a.features.includes("payments"))) out.push({ kind: "operator_capabilities_unavailable", severity: "high", title: `${def.name}: key paid capabilities unavailable`, why: input.paidCapabilityGaps.join("; "), nextAction: "Connect the real systems on the Connections page." });
  const current = def.features;
  const removed = a.features.filter((f) => !current.includes(f));
  const added = current.filter((f) => !a.features.includes(f));
  if (removed.length || added.length) out.push({ kind: "catalog_changed_for_plan", severity: a.foundingCustomer ? "high" : "low", title: "The plan catalog changed for this customer's plan", why: `Purchased ${a.planVersion}: ${removed.length ? `no longer in catalog: ${removed.join(", ")}` : ""}${removed.length && added.length ? "; " : ""}${added.length ? `new in catalog: ${added.join(", ")}` : ""}. The customer keeps what they bought until the founder reviews it.`, nextAction: "Review and re-confirm the plan (audited)." });
  return out;
}
