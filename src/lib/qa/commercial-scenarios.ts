import type { BusinessGraph } from "@/lib/business-graph";
import { graphOrNull } from "@/lib/learn-business/http";
import { isActionAvailable } from "@/lib/business-graph";
import { listBusinessSummaries } from "@/lib/fixtures";
import { decide } from "@/lib/policy";
import { applyControlChange, loadControls } from "@/lib/hq/controls";
import { activateFreePeriod, cancelSubscription, commercialStage, CommercialError, freePeriodProgress, getCommercialAccount, listCommercialEvents, markSetupPaid, quoteSetup, selectPlan } from "@/lib/commercial/account";
import { costToServe, listCostRecords, listModelUsage, listSupportTime, monthPeriod, recordCost } from "@/lib/commercial/cost";
import { unitEconomics } from "@/lib/commercial/economics";
import { commercialAlerts } from "@/lib/commercial/alerts";
import { executability, setEntitlement } from "@/lib/commercial/entitlements";
import { PLAN_CATALOG, type PlanId } from "@/lib/commercial/plans";
import type { CommercialReadiness } from "@/lib/commercial/readiness";
import { qaEnabled } from "./mode";

/**
 * COMMERCIAL QA SCENARIOS (QA mode only). Each runs on its own sandbox business id
 * (`qa-commercial:<scenario>:<run>`) so no real business's commercial state is touched, executes the
 * real commercial code paths (account workflow, billing boundary, cost ledger, economics, alerts,
 * entitlement + authority), and CHECKS its own expectation: PASS / FAIL with what it observed.
 */

export type CommercialQaScenarioId =
  | "core_free_month"
  | "operator_setup_paid_free_month"
  | "intelligence_no_cost_evidence"
  | "cost_guardrail_breach"
  | "trial_ending_soon"
  | "core_denied_operator_capability"
  | "intelligence_denied_by_authority"
  | "setup_unpaid_blocks_activation"
  | "founder_activates_free_period"
  | "plan_change_audit";

export const COMMERCIAL_QA_SCENARIOS: { id: CommercialQaScenarioId; title: string; expect: string }[] = [
  { id: "core_free_month", title: "Core: free month running", expect: "CORE account, setup paid, free period day 1 of 30, recurring planned at the free-period end, no recurring revenue yet." },
  { id: "operator_setup_paid_free_month", title: "Operator: setup paid → free month active", expect: "OPERATOR at 899 USD, setup 1500 paid (setup revenue reported apart), subscription in free period." },
  { id: "intelligence_no_cost_evidence", title: "Intelligence without cost evidence", expect: "An 'Intelligence without cost evidence' founder alert; no savings fabricated." },
  { id: "cost_guardrail_breach", title: "Cost-to-serve above guardrail", expect: "A measured 400 USD hosting cost on CORE (guardrail 120) → above guardrail + founder alert; nothing changes for the customer." },
  { id: "trial_ending_soon", title: "Free month ending soon", expect: "Free period started 25 days ago → stage 'free month ending' + alert." },
  { id: "core_denied_operator_capability", title: "Core plan: Operator-only capability", expect: "addToCart on CORE → UNAVAILABLE (plan), never an owner request; searchProducts stays executable." },
  { id: "intelligence_denied_by_authority", title: "Intelligence: authority still denies", expect: "Founder paused consequential writes → addToCart DENIED by authority even on INTELLIGENCE (the plan never loosens it)." },
  { id: "setup_unpaid_blocks_activation", title: "Setup unpaid blocks activation", expect: "Activation refused while setup is only quoted — even with an override reason." },
  { id: "founder_activates_free_period", title: "Founder activates the free period (override, audited)", expect: "Readiness NOT READY → activation refused without a reason; with an override reason the free period starts and the audit shows OVERRIDE." },
  { id: "plan_change_audit", title: "Plan change audit + founding lock", expect: "CORE → OPERATOR → (founding, locked) downgrade to CORE refused without confirmation; every change audited." },
];

export type CommercialQaRun = { id: CommercialQaScenarioId; businessId: string; outcome: "pass" | "fail"; observed: Record<string, unknown>; failures: string[] };

const DAY = 24 * 3600_000;
const FOUNDER = "qa-founder";
const notReady: CommercialReadiness = { level: "NOT_READY", blocker: "QA sandbox: launch gate not evaluated", items: [] };

export async function runCommercialQaScenario(id: CommercialQaScenarioId, opts: { now?: Date } = {}): Promise<CommercialQaRun> {
  if (!qaEnabled()) throw new Error("QA scenarios are only available in QA mode");
  if (!COMMERCIAL_QA_SCENARIOS.some((s) => s.id === id)) throw new Error(`Unknown commercial QA scenario: ${id}`);
  const now = opts.now ?? new Date();
  const businessId = `qa-commercial:${id}:${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const failures: string[] = [];
  const observed: Record<string, unknown> = {};
  const expect = (cond: boolean, what: string) => {
    if (!cond) failures.push(what);
  };
  const meta = (reason: string, at = now) => ({ by: FOUNDER, reason, now: at });
  const onboard = async (plan: PlanId, at: Date) => {
    await selectPlan(businessId, { plan, setupPrice: PLAN_CATALOG[plan].setupFrom ?? 0, source: "qa" }, meta("QA plan", at));
    await quoteSetup(businessId, { setupPrice: PLAN_CATALOG[plan].setupFrom ?? 0 }, meta("QA quote", at));
    await markSetupPaid(businessId, { reference: "qa-bank-transfer" }, meta("QA setup paid", at));
    return activateFreePeriod(businessId, { gateLevel: "READY_TO_START_FREE_MONTH" }, meta("QA activation (sandbox gate)", at));
  };
  const economicsNow = async () => {
    const account = await getCommercialAccount(businessId);
    const cost = costToServe({ period: monthPeriod(now), records: await listCostRecords(businessId), usage: await listModelUsage(businessId), support: await listSupportTime(businessId) });
    const economics = unitEconomics({ account, events: await listCommercialEvents(businessId), cost, now });
    return { account, cost, economics };
  };
  // Any available business that sells through a cart, copied onto the sandbox id (no real tenant touched).
  const seller = (): BusinessGraph => {
    const g = listBusinessSummaries().map((b) => graphOrNull(b.id)).find((x): x is BusinessGraph => !!x && isActionAvailable(x, "addToCart"));
    if (!g) throw new Error("No cart-selling business is available here");
    return { ...g, business: { ...g.business, id: businessId } };
  };

  switch (id) {
    case "core_free_month": {
      const { account } = await onboard("CORE", now);
      const { economics } = await economicsNow();
      const free = freePeriodProgress(account, now);
      Object.assign(observed, { stage: commercialStage(account, now), freeDay: free?.day, endsAt: account.freePeriodEndsAt, recurringRevenue: economics.recurringRevenue });
      expect(account.subscriptionState === "free_period", "subscription is not in the free period");
      expect(free?.day === 1 && free.daysLeft === 30, "free period is not day 1 of 30");
      expect(account.recurringStartsAt === account.freePeriodEndsAt, "recurring is not planned at the free-period end");
      expect(economics.recurringRevenue === 0, "free days earned recurring revenue");
      break;
    }
    case "operator_setup_paid_free_month": {
      const { account } = await onboard("OPERATOR", now);
      const { economics } = await economicsNow();
      Object.assign(observed, { plan: account.plan, monthly: account.monthlyPrice, setup: account.setupPrice, setupStatus: account.setupStatus, setupRevenue: economics.setupRevenue, recurringRevenue: economics.recurringRevenue });
      expect(account.plan === "OPERATOR" && account.monthlyPrice === 899, "not OPERATOR at 899");
      expect(account.setupStatus === "paid" && economics.setupRevenue === 1500, "setup revenue not reported apart");
      expect(economics.recurringRevenue === 0, "setup mixed into recurring");
      break;
    }
    case "intelligence_no_cost_evidence": {
      await onboard("INTELLIGENCE", now);
      const { account, cost, economics } = await economicsNow();
      const alerts = commercialAlerts({ account, readiness: notReady, economics, cost, usage: [], value: null, costEvidenceCount: 0, paidCapabilityGaps: [], now });
      observed.alerts = alerts.map((a) => a.kind);
      expect(alerts.some((a) => a.kind === "intelligence_without_cost_evidence"), "no 'Intelligence without cost evidence' alert");
      break;
    }
    case "cost_guardrail_breach": {
      await onboard("CORE", now);
      const p = monthPeriod(now);
      await recordCost(businessId, { category: "hosting_compute", provider: "qa-hosting", amount: 400, currency: "USD", basis: "measured", source: "QA invoice allocation", periodStart: p.start, periodEnd: new Date(Date.parse(p.end) - 1).toISOString() }, FOUNDER);
      const { account, cost, economics } = await economicsNow();
      const alerts = commercialAlerts({ account, readiness: notReady, economics, cost, usage: [], value: null, costEvidenceCount: 0, paidCapabilityGaps: [], now });
      Object.assign(observed, { costToServe: economics.costToServe, guardrail: economics.guardrail, aboveGuardrail: economics.aboveGuardrail, alerts: alerts.map((a) => a.kind), subscription: account?.subscriptionState });
      expect(economics.aboveGuardrail, "not above guardrail");
      expect(alerts.some((a) => a.kind === "cost_above_guardrail"), "no guardrail alert");
      expect(account?.subscriptionState === "free_period", "the customer's subscription changed");
      break;
    }
    case "trial_ending_soon": {
      const { account } = await onboard("OPERATOR", new Date(now.getTime() - 25 * DAY));
      const { cost, economics } = await economicsNow();
      const alerts = commercialAlerts({ account, readiness: notReady, economics, cost, usage: [], value: null, costEvidenceCount: 0, paidCapabilityGaps: [], now });
      Object.assign(observed, { stage: commercialStage(account, now), alerts: alerts.map((a) => a.kind) });
      expect(commercialStage(account, now) === "free_month_ending", "stage is not 'free month ending'");
      expect(alerts.some((a) => a.kind === "free_period_ending"), "no free-period-ending alert");
      break;
    }
    case "core_denied_operator_capability": {
      const g = seller();
      setEntitlement(businessId, { plan: "CORE", features: [...PLAN_CATALOG.CORE.features], emulated: true });
      const cart = decide(g, { action: "addToCart", params: { productId: "qa-product", quantity: 1 } });
      const search = decide(g, { action: "searchProducts", params: { text: "qa" } });
      Object.assign(observed, { addToCart: executability(cart), addToCartReason: cart.reason, searchProducts: executability(search) });
      expect(executability(cart) === "unavailable", "addToCart is not UNAVAILABLE on CORE");
      expect(cart.status !== "requires_approval", "a plan-locked action became an owner request");
      expect(executability(search) === "executable", "searchProducts is not executable on CORE");
      break;
    }
    case "intelligence_denied_by_authority": {
      const g = seller();
      setEntitlement(businessId, { plan: "INTELLIGENCE", features: [...PLAN_CATALOG.INTELLIGENCE.features], emulated: true });
      await applyControlChange(businessId, { pauseConsequentialWrites: true }, { by: FOUNDER, reason: "QA: authority denies" });
      await loadControls(businessId);
      const cart = decide(g, { action: "addToCart", params: { productId: "qa-product", quantity: 1 } });
      Object.assign(observed, { addToCart: executability(cart), policyId: cart.policyId });
      expect(executability(cart) === "denied", "authority denial was not DENIED");
      break;
    }
    case "setup_unpaid_blocks_activation": {
      await selectPlan(businessId, { plan: "CORE", setupPrice: 750 }, meta("QA plan"));
      await quoteSetup(businessId, { setupPrice: 750 }, meta("QA quote"));
      let refused = "";
      try {
        await activateFreePeriod(businessId, { gateLevel: "READY_TO_START_FREE_MONTH", override: "QA tries to force it" }, meta("QA activation"));
      } catch (err) {
        refused = err instanceof CommercialError ? err.message : String(err);
      }
      const a = await getCommercialAccount(businessId);
      Object.assign(observed, { refused, subscription: a?.subscriptionState });
      expect(/not paid or waived/.test(refused), "activation was not refused for unpaid setup");
      expect(a?.subscriptionState === "pre_activation", "the free month started");
      break;
    }
    case "founder_activates_free_period": {
      await selectPlan(businessId, { plan: "OPERATOR", setupPrice: 1500 }, meta("QA plan"));
      await quoteSetup(businessId, { setupPrice: 1500 }, meta("QA quote"));
      await markSetupPaid(businessId, {}, meta("QA setup paid"));
      let refused = "";
      try {
        await activateFreePeriod(businessId, { gateLevel: "NOT_READY", gateBlocker: notReady.blocker! }, meta("QA activation"));
      } catch (err) {
        refused = err instanceof Error ? err.message : String(err);
      }
      const { account, event } = await activateFreePeriod(businessId, { gateLevel: "NOT_READY", gateBlocker: notReady.blocker!, override: "QA: founder accepts the sandbox gate" }, meta("QA activation"));
      Object.assign(observed, { refusedWithoutReason: refused, subscription: account.subscriptionState, override: account.activation?.override, auditReason: event.reason });
      expect(/Not ready to start the free month/.test(refused), "activation without a reason was not refused");
      expect(account.subscriptionState === "free_period", "free period did not start");
      expect(event.reason.startsWith("OVERRIDE:"), "the override is not in the audit");
      break;
    }
    case "plan_change_audit": {
      await selectPlan(businessId, { plan: "CORE" }, meta("QA start on Core"));
      await selectPlan(businessId, { plan: "OPERATOR", foundingCustomer: true, priceLockMonths: 12 }, meta("QA upgrade, founding lock"));
      let refused = "";
      try {
        await selectPlan(businessId, { plan: "CORE" }, meta("QA downgrade"));
      } catch (err) {
        refused = err instanceof Error ? err.message : String(err);
      }
      await selectPlan(businessId, { plan: "CORE", confirmFeatureRemoval: true }, meta("QA downgrade after founder review"));
      await cancelSubscription(businessId, {}, meta("QA cleanup"));
      const events = await listCommercialEvents(businessId);
      Object.assign(observed, { refused, events: events.map((e) => `${e.kind} by ${e.by}: ${e.reason}`) });
      expect(/Founding customer under price lock/.test(refused), "locked downgrade was not refused");
      expect(events.filter((e) => e.kind === "plan_changed").length === 2 && events.every((e) => e.by && e.reason), "plan changes are not all audited");
      break;
    }
  }
  return { id, businessId, outcome: failures.length ? "fail" : "pass", observed, failures };
}
