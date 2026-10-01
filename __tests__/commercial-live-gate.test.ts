import { describe, expect, it } from "vitest";
import { runCommercialQaScenario } from "@/lib/qa/commercial-scenarios";
import { PLAN_CATALOG } from "@/lib/commercial/plans";
import { FREE_PERIOD_DAYS } from "@/lib/commercial/plans";
import { getCommercialAccount, selectPlan, quoteSetup, markSetupPaid, activateFreePeriod, loadEntitlement, freePeriodProgress } from "@/lib/commercial/account";
import { costToServe, monthPeriod, recordModelUsage, recordCost, listCostRecords, listModelUsage, listSupportTime } from "@/lib/commercial/cost";
import { unitEconomics } from "@/lib/commercial/economics";
import { commercialAlerts } from "@/lib/commercial/alerts";
import { listCommercialEvents } from "@/lib/commercial/account";
import type { ModelCall } from "@/lib/commercial/usage-meter";

/**
 * COMMERCIALIZATION GATE (deterministic, isolated sandbox businesses — no real tenant's commercial state
 * is touched): plan vs authority, lifecycle and revenue separation, cost / economics with gpt-5.6-sol,
 * readiness / alerts. Value truth (MADE / SAVED) is proven in commercial-operability.test.ts.
 */
const now = new Date("2026-10-10T12:00:00.000Z");

describe("A. plan vs authority", () => {
  for (const id of ["core_denied_operator_capability", "intelligence_denied_by_authority"] as const) {
    it(`${id} passes`, async () => {
      const r = await runCommercialQaScenario(id, { now });
      expect(r.failures, JSON.stringify(r.observed)).toEqual([]);
      expect(r.outcome).toBe("pass");
    });
  }
});

describe("B. lifecycle", () => {
  it("setup_unpaid_blocks_activation and operator_setup_paid_free_month pass", async () => {
    for (const id of ["setup_unpaid_blocks_activation", "operator_setup_paid_free_month"] as const) {
      const r = await runCommercialQaScenario(id, { now });
      expect(r.failures, `${id}: ${JSON.stringify(r.observed)}`).toEqual([]);
    }
  });

  it("setup revenue stays apart from recurring; the free month is 30 days and recurring starts only afterward", async () => {
    const biz = `gate-life-${Date.now()}`;
    await selectPlan(biz, { plan: "OPERATOR", setupPrice: 1500 }, { by: "qa", reason: "plan", now });
    await quoteSetup(biz, { setupPrice: 1500 }, { by: "qa", reason: "quote", now });
    await markSetupPaid(biz, { reference: "ref" }, { by: "qa", reason: "paid", now });
    const { account } = await activateFreePeriod(biz, { gateLevel: "READY_TO_START_FREE_MONTH" }, { by: "qa", reason: "go", now });
    expect(FREE_PERIOD_DAYS).toBe(30);
    expect(Date.parse(account.freePeriodEndsAt!) - Date.parse(account.freePeriodStartsAt!)).toBe(30 * 24 * 3600_000);
    expect(account.recurringStartsAt).toBe(account.freePeriodEndsAt);
    expect(account.recurringConfirmedAt).toBeNull();
    const cost = costToServe({ period: monthPeriod(now), records: [], usage: [], support: [] });
    const during = unitEconomics({ account, events: await listCommercialEvents(biz), cost, now });
    expect(during.setupRevenue).toBe(1500);
    expect(during.recurringRevenue).toBe(0);
    expect(freePeriodProgress(account, now)).toMatchObject({ day: 1, daysLeft: 30 });
  });
});

describe("C. cost / economics with gpt-5.6-sol", () => {
  const sol = (over: Partial<ModelCall> = {}): ModelCall => ({ model: "gpt-5.6-sol", role: "reasoner", inputTokens: 5548, outputTokens: 355, cachedTokens: 0, reasoningTokens: 61, providerReported: true, at: now.toISOString(), ...over }) as ModelCall;

  it("a new provider-reported gpt-5.6-sol turn has a non-null estimate that HQ cost-to-serve includes, labelled estimated", async () => {
    const biz = `gate-cost-${Date.now()}`;
    await recordModelUsage(biz, { conversationId: "c", turnId: "t" }, [sol(), sol({ model: "gpt-4o-mini", role: "composer", inputTokens: 2000, outputTokens: 100 })]);
    const usage = await listModelUsage(biz);
    expect(usage.every((u) => u.estimatedCostUsd !== null)).toBe(true);
    const cost = costToServe({ period: monthPeriod(now), records: await listCostRecords(biz), usage, support: await listSupportTime(biz) });
    expect(cost.model.unpricedCalls).toBe(0);
    expect(cost.model.byModel["gpt-5.6-sol"].estimatedUsd).toBeCloseTo(0.029292, 3);
    const line = cost.lines.find((l) => l.category === "ai_model")!;
    expect(line.basis).toBe("estimated");
    expect(line.amount).toBeGreaterThan(0.029);
    expect(line.detail).toMatch(/rates-2026-10-v2/);
    expect(cost.allMeasured).toBe(false);
  });

  it("cost_guardrail_breach raises a founder alert and leaves the customer's subscription and entitlement untouched", async () => {
    const r = await runCommercialQaScenario("cost_guardrail_breach", { now });
    expect(r.failures, JSON.stringify(r.observed)).toEqual([]);
    expect(r.observed.alerts).toContain("cost_above_guardrail");
    expect(r.observed.subscription).toBe("free_period");
    const account = await getCommercialAccount(r.businessId);
    expect(account?.plan).toBe("CORE");
    expect((await loadEntitlement(r.businessId)).features).toEqual(expect.arrayContaining([...PLAN_CATALOG.CORE.features]));
  });
});

describe("E. readiness / alerts", () => {
  it("Intelligence without cost evidence alerts the founder; no savings are fabricated", async () => {
    const r = await runCommercialQaScenario("intelligence_no_cost_evidence", { now });
    expect(r.failures, JSON.stringify(r.observed)).toEqual([]);
    expect(r.observed.alerts).toContain("intelligence_without_cost_evidence");
    const biz = r.businessId;
    const account = await getCommercialAccount(biz);
    const cost = costToServe({ period: monthPeriod(now), records: [], usage: [], support: [] });
    const alerts = commercialAlerts({ account, readiness: { level: "NOT_READY", blocker: "x", items: [] }, economics: unitEconomics({ account, events: [], cost, now }), cost, usage: [], value: null, costEvidenceCount: 0, paidCapabilityGaps: [], now });
    expect(alerts.some((a) => a.kind === "intelligence_without_cost_evidence")).toBe(true);
    void recordCost;
  });
});
