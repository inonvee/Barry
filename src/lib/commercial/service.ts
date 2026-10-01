import type { BusinessGraph } from "@/lib/business-graph";
import { loadControls } from "@/lib/hq/controls";
import { launchChecklist, type LaunchGate } from "@/lib/hq/launch";
import { getBusinessStatus } from "@/lib/hq/fleet";
import { assessCapabilities } from "@/lib/owner/capabilities";
import { listCostEvidence } from "@/lib/finance/evidence";
import type { Money } from "@/lib/owner/revenue";
import { commercialStage, effectiveMonthlyPrice, freePeriodProgress, getCommercialAccount, listCommercialAccounts, listCommercialEvents, loadEntitlement, STAGE_WORDS, type CommercialAccount, type CommercialEvent, type CommercialStage } from "./account";
import { costToServe, listCostRecords, listModelUsage, listSupportTime, monthPeriod, type CostToServe, type Period } from "./cost";
import { unitEconomics, type UnitEconomics } from "./economics";
import { commercialReadiness, type CommercialReadiness } from "./readiness";
import { commercialAlerts, type CommercialAlert } from "./alerts";
import { loadValueAccount, type ValueAccount } from "./value";
import { getCommercialBilling } from "./billing";
import { FEATURE_WORDS, FREE_PERIOD_DAYS, PLAN_CATALOG, planUnlocking, STANDARD_PLANS, type Feature, type PlanId } from "./plans";
import { currentEntitlement, hasFeature } from "./entitlements";

/**
 * Read models for the founder (HQ → Commercial: economics + commercial state) and for the owner
 * (Settings → plan + value). The OWNER view is built from a separate, explicit allow-list: it never
 * contains cost-to-serve, AI cost, gross contribution, margin or provider economics.
 */

export type TrialSummary = {
  window: Period;
  complete: boolean;
  didWhat: string[];
  measuredValue: { generated: Money; recovered: Money; savedRealized: Money; needsYou: number };
  remainingGaps: string[];
  costToServe: { total: Record<string, number>; missing: string[]; basis: string; supportMinutes: number; modelUsd: number };
  health: { incidentsOpen: number; incidentsHigh: number; aiStatus: string; readiness: string };
  autoCharge: false;
  billingNote: string;
};

export type CommercialBusiness = {
  business: { id: string; name: string };
  account: CommercialAccount | null;
  stage: CommercialStage;
  stageWords: string;
  effectivePrice: number | null;
  freePeriod: ReturnType<typeof freePeriodProgress>;
  events: CommercialEvent[];
  readiness: CommercialReadiness;
  launchLevel: LaunchGate["level"];
  period: Period;
  cost: CostToServe;
  economics: UnitEconomics;
  value: ValueAccount | null;
  alerts: CommercialAlert[];
  trial: TrialSummary | null;
  billing: { provider: string; chargesAutomatically: boolean };
  unavailable: string[];
};

async function paidCapabilityGaps(graph: BusinessGraph): Promise<string[]> {
  const a = await assessCapabilities(graph).catch(() => undefined);
  if (!a) return ["capability assessment unavailable"];
  return a.needs.filter((n) => (n.area === "sell" || n.area === "money" || n.area === "book") && n.status !== "ready").map((n) => `${n.title}: ${n.status.replace(/_/g, " ")}`);
}

export async function getCommercialBusiness(graph: BusinessGraph, opts: { now?: Date } = {}): Promise<CommercialBusiness> {
  const now = opts.now ?? new Date();
  const id = graph.business.id;
  const unavailable: string[] = [];
  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      unavailable.push(`${label}: ${err instanceof Error ? err.message : "unavailable"}`);
      return fallback;
    }
  };
  await loadEntitlement(id);
  const [account, events, records, usage, support, evidence, controls] = await Promise.all([
    safe("commercial account", () => getCommercialAccount(id), null),
    safe("commercial events", () => listCommercialEvents(id), []),
    safe("cost records", () => listCostRecords(id), []),
    safe("model usage", () => listModelUsage(id), []),
    safe("support time", () => listSupportTime(id), []),
    safe("cost evidence", () => listCostEvidence(id), []),
    loadControls(id),
  ]);
  const period = monthPeriod(now);
  const cost = costToServe({ period, records, usage, support });
  const economics = unitEconomics({ account, events, cost, now });
  const launch = await launchChecklist(graph, { controls });
  const readiness = commercialReadiness({ account, launch, controls });
  const value = await safe("value", () => loadValueAccount(graph, period, now), null);
  const gaps = await paidCapabilityGaps(graph);
  const alerts = commercialAlerts({ account, readiness, economics, cost, usage, value, costEvidenceCount: evidence.length, paidCapabilityGaps: gaps, now });
  let trial: TrialSummary | null = null;
  if (account?.freePeriodStartsAt && account.freePeriodEndsAt) {
    const end = new Date(Math.min(now.getTime(), Date.parse(account.freePeriodEndsAt)) + 1);
    const window: Period = { start: account.freePeriodStartsAt, end: end.toISOString(), label: "free month" };
    const trialValue = await safe("trial value", () => loadValueAccount(graph, window, now), null);
    const trialCost = costToServe({ period: window, records, usage, support });
    const status = await safe("business status", () => getBusinessStatus(graph, { now }), null);
    trial = {
      window,
      complete: now.toISOString() >= account.freePeriodEndsAt,
      didWhat: trialValue
        ? [
            `Handled ${trialValue.handled.conversations} conversation(s) with no human`,
            ...Object.entries(trialValue.handled.byKind).map(([k, n]) => `${n} × ${k.replace(/_/g, " ")} (verified)`),
            `Active conversations: ${trialValue.activeConversations}`,
          ]
        : ["Activity unavailable"],
      measuredValue: { generated: trialValue?.made.generated ?? {}, recovered: trialValue?.made.recovered ?? {}, savedRealized: trialValue?.saved.realized ?? {}, needsYou: trialValue?.needsYou.conversations ?? 0 },
      remainingGaps: [...gaps, ...readiness.items.filter((i) => !i.ready && i.id !== "free_month.unused").map((i) => `${i.title}: ${i.blocker ?? i.evidence}`)].slice(0, 8),
      costToServe: { total: trialCost.total, missing: trialCost.missing, basis: trialCost.allMeasured ? "measured" : "estimated / partial", supportMinutes: trialCost.supportMinutes, modelUsd: trialCost.model.estimatedUsd },
      health: { incidentsOpen: status?.incidents.open.length ?? 0, incidentsHigh: status?.incidents.high ?? 0, aiStatus: status?.model.status ?? "unknown", readiness: status?.readiness.label ?? "unknown" },
      autoCharge: false,
      billingNote: getCommercialBilling().chargesAutomatically ? "A billing provider is connected." : "No billing provider is connected: nothing is charged automatically. The founder confirms the recurring start and invoices manually.",
    };
  }
  return {
    business: { id, name: graph.business.name },
    account,
    stage: commercialStage(account, now),
    stageWords: STAGE_WORDS[commercialStage(account, now)],
    effectivePrice: account ? effectiveMonthlyPrice(account, now) : null,
    freePeriod: freePeriodProgress(account, now),
    events,
    readiness,
    launchLevel: launch.level,
    period,
    cost,
    economics,
    value,
    alerts,
    trial,
    billing: { provider: getCommercialBilling().provider, chargesAutomatically: getCommercialBilling().chargesAutomatically },
    unavailable,
  };
}

// ── Fleet ────────────────────────────────────────────────────────────────────────────────────────

export type CommercialFleetRow = {
  id: string;
  name: string;
  plan: PlanId | null;
  stage: CommercialStage;
  stageWords: string;
  monthlyPrice: number | null;
  currency: string;
  setupStatus: string;
  freeDay: number | null;
  freeEndsAt: string | null;
  costToServe: number | null;
  costBasis: UnitEconomics["costBasis"];
  costComplete: boolean;
  grossContribution: number | null;
  grossMarginPct: number | null;
  aboveGuardrail: boolean;
  alerts: number;
};

export type CommercialFleet = {
  period: Period;
  mrr: Record<string, number>;
  freeMonth: number;
  setup: { paid: number; unpaid: number; waived: number };
  active: number;
  cancelled: number;
  contribution: { plan: PlanId; currency: string; recurring: number; cost: number; contribution: number }[];
  aboveGuardrail: string[];
  costByCategory: Record<string, number>;
  valueVsCost: { id: string; name: string; made: Money; cost: number | null }[];
  rows: CommercialFleetRow[];
};

/** Contracted MRR: paid-active subscriptions at their effective price, grouped by currency. */
export async function getCommercialFleet(graphs: BusinessGraph[], opts: { now?: Date } = {}): Promise<CommercialFleet> {
  const now = opts.now ?? new Date();
  const accounts = new Map((await listCommercialAccounts().catch(() => [])).map((a) => [a.businessId, a]));
  const period = monthPeriod(now);
  const rows: CommercialFleetRow[] = [];
  const mrr: Record<string, number> = {};
  const contribution = new Map<string, { plan: PlanId; currency: string; recurring: number; cost: number; contribution: number }>();
  const costByCategory: Record<string, number> = {};
  const valueVsCost: CommercialFleet["valueVsCost"] = [];
  let freeMonth = 0, active = 0, cancelled = 0;
  const setup = { paid: 0, unpaid: 0, waived: 0 };
  for (const graph of graphs) {
    const id = graph.business.id;
    const a = accounts.get(id) ?? null;
    const [records, usage, support, events] = await Promise.all([listCostRecords(id).catch(() => []), listModelUsage(id).catch(() => []), listSupportTime(id).catch(() => []), a ? listCommercialEvents(id).catch(() => []) : Promise.resolve([])]);
    const cost = costToServe({ period, records, usage, support });
    for (const l of cost.lines) if (l.amount !== null && l.currency === "USD") costByCategory[l.category] = Math.round(((costByCategory[l.category] ?? 0) + l.amount) * 100) / 100;
    const econ = unitEconomics({ account: a, events, cost, now });
    const stage = commercialStage(a, now);
    if (a) {
      if (a.subscriptionState === "active") {
        mrr[a.currency] = (mrr[a.currency] ?? 0) + effectiveMonthlyPrice(a, now);
        active++;
      }
      if (a.subscriptionState === "free_period") freeMonth++;
      if (a.subscriptionState === "cancelled") cancelled++;
      if (a.setupStatus === "paid") setup.paid++;
      else if (a.setupStatus === "waived") setup.waived++;
      else setup.unpaid++;
      const k = `${a.plan}:${a.currency}`;
      const c = contribution.get(k) ?? { plan: a.plan, currency: a.currency, recurring: 0, cost: 0, contribution: 0 };
      c.recurring += econ.recurringRevenue;
      c.cost += econ.costToServe ?? 0;
      c.contribution = Math.round((c.recurring - c.cost) * 100) / 100;
      contribution.set(k, c);
    }
    const free = freePeriodProgress(a, now);
    rows.push({ id, name: graph.business.name, plan: a?.plan ?? null, stage, stageWords: STAGE_WORDS[stage], monthlyPrice: a ? effectiveMonthlyPrice(a, now) : null, currency: a?.currency ?? "USD", setupStatus: a?.setupStatus ?? "—", freeDay: free?.day ?? null, freeEndsAt: a?.freePeriodEndsAt ?? null, costToServe: econ.costToServe, costBasis: econ.costBasis, costComplete: econ.costComplete, grossContribution: econ.grossContribution, grossMarginPct: econ.grossMarginPct, aboveGuardrail: econ.aboveGuardrail, alerts: (econ.aboveGuardrail ? 1 : 0) + (stage === "awaiting_recurring" || stage === "free_month_ending" ? 1 : 0) });
    if (a) {
      // Value delivered vs cost: verified generated + recovered (per currency) against cost-to-serve.
      const v = await loadValueAccount(graph, period, now).catch(() => null);
      const made: Money = { ...(v?.made.generated ?? {}) };
      for (const [c, n] of Object.entries(v?.made.recovered ?? {})) made[c] = Math.round(((made[c] ?? 0) + n) * 100) / 100;
      valueVsCost.push({ id, name: graph.business.name, made, cost: econ.costToServe });
    }
  }
  return { period, mrr, freeMonth, setup, active, cancelled, contribution: [...contribution.values()], aboveGuardrail: rows.filter((r) => r.aboveGuardrail).map((r) => r.name), costByCategory, valueVsCost, rows };
}

// ── Owner view (allow-list: plan + value; never economics) ────────────────────────────────────────

export type OwnerPlanView = {
  plan: { id: PlanId; name: string; promise: string; monthlyPrice: number; currency: string; priceLockedUntil: string | null } | null;
  subscription: { state: string; freeMonth: { day: number; daysLeft: number; endsAt: string } | null; recurringStartsAt: string | null };
  canDo: string[];
  planLocked: { feature: string; unlockedBy: string }[];
  upgrades: { id: PlanId; name: string; promise: string; monthlyPrice: number; currency: string; unlocks: string[] }[];
  value: {
    period: string;
    handled: number;
    outcomes: number;
    generated: Money;
    recovered: Money;
    savedRealized: Money;
    savedNote: string | null;
    needsYou: number;
    workingOn: string[];
    blocked: string[];
    unlockNext: string[];
  } | null;
};

export async function getOwnerPlanView(graph: BusinessGraph, opts: { now?: Date } = {}): Promise<OwnerPlanView> {
  const now = opts.now ?? new Date();
  const a = await getCommercialAccount(graph.business.id).catch(() => null);
  await loadEntitlement(graph.business.id);
  const e = currentEntitlement(graph.business.id);
  const value = await loadValueAccount(graph, monthPeriod(now), now).catch(() => null);
  const features = (Object.keys(FEATURE_WORDS) as Feature[]);
  const canDo = features.filter((f) => hasFeature(e, f)).map((f) => FEATURE_WORDS[f]);
  const planLocked = e.plan ? features.filter((f) => !hasFeature(e, f)).map((f) => ({ feature: FEATURE_WORDS[f], unlockedBy: PLAN_CATALOG[planUnlocking(f) ?? "CUSTOM"].name })) : [];
  const currentIdx = a ? STANDARD_PLANS.indexOf(a.plan) : -1;
  const upgrades = a && a.plan !== "CUSTOM"
    ? STANDARD_PLANS.slice(currentIdx + 1).map((p) => ({ id: p, name: PLAN_CATALOG[p].name, promise: PLAN_CATALOG[p].promise, monthlyPrice: PLAN_CATALOG[p].monthlyPrice!, currency: PLAN_CATALOG[p].currency, unlocks: PLAN_CATALOG[p].features.filter((f) => !a.features.includes(f)).map((f) => FEATURE_WORDS[f]) }))
    : [];
  const free = freePeriodProgress(a, now);
  return {
    plan: a ? { id: a.plan, name: PLAN_CATALOG[a.plan].name, promise: PLAN_CATALOG[a.plan].promise, monthlyPrice: effectiveMonthlyPrice(a, now), currency: a.currency, priceLockedUntil: a.foundingCustomer ? a.priceLockUntil : null } : null,
    subscription: { state: a ? a.subscriptionState.replace(/_/g, " ") : "no plan yet", freeMonth: free, recurringStartsAt: a?.recurringStartsAt ?? null },
    canDo,
    planLocked,
    upgrades,
    value: value
      ? { period: value.period.label, handled: value.handled.conversations, outcomes: value.handled.outcomes, generated: value.made.generated, recovered: value.made.recovered, savedRealized: value.saved.realized, savedNote: value.saved.marginsNote, needsYou: value.needsYou.conversations, workingOn: value.workingOn, blocked: value.blocked, unlockNext: value.unlockNext }
      : null,
  };
}

/** The owner asks to upgrade / talk to BARRY: a request only — plans change only by the founder. */
export async function requestPlanChange(businessId: string, input: { plan?: PlanId; message?: string }, by: string) {
  const { getBackend } = await import("@/lib/store");
  const at = new Date().toISOString();
  const id = `creq_${Date.parse(at).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = { id, businessId, at, by, plan: input.plan && PLAN_CATALOG[input.plan] ? input.plan : null, message: (input.message ?? "").slice(0, 500), status: "open" };
  await getBackend().upsertOperatorRecord({ businessId, kind: "commercial_request", key: id, data });
  return data;
}

export async function listPlanRequests(businessId: string) {
  const { getBackend } = await import("@/lib/store");
  return (await getBackend().listOperatorRecords(businessId, "commercial_request")).map((r) => r.data as { id: string; at: string; by: string; plan: PlanId | null; message: string; status: string }).sort((a, b) => b.at.localeCompare(a.at));
}

export const DAYS_IN_FREE_PERIOD = FREE_PERIOD_DAYS;
