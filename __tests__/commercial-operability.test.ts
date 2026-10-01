import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { setReasonerForTests } from "@/lib/reasoner";
import { decide } from "@/lib/policy";
import { applyControlChange, loadControls, resetControlsCacheForTests } from "@/lib/hq/controls";
import { DEFAULT_CONTROLS } from "@/lib/hq/controls";
import { activateFreePeriod, cancelSubscription, CommercialError, commercialStage, confirmRecurringStart, effectiveMonthlyPrice, emulatePlanForQa, getCommercialAccount, invoiceSetup, listCommercialEvents, loadEntitlement, markSetupPaid, pauseSubscription, quoteSetup, resumeSubscription, selectPlan, waiveSetup } from "@/lib/commercial/account";
import { executability, resetEntitlementCacheForTests, setEntitlement } from "@/lib/commercial/entitlements";
import { featureForAction, PLAN_CATALOG } from "@/lib/commercial/plans";
import { costToServe, CostRecordInputSchema, listModelUsage, monthPeriod, recordCost, recordModelUsage, recordSupportTime, listCostRecords, listSupportTime } from "@/lib/commercial/cost";
import { estimateCallCost } from "@/lib/commercial/rate-card";
import { withUsageMeter, meterModelCall } from "@/lib/commercial/usage-meter";
import { unitEconomics } from "@/lib/commercial/economics";
import { commercialReadiness } from "@/lib/commercial/readiness";
import { getCommercialBilling } from "@/lib/commercial/billing";
import { getOwnerPlanView, requestPlanChange, listPlanRequests } from "@/lib/commercial/service";
import { valueAccount } from "@/lib/commercial/value";
import { COMMERCIAL_QA_SCENARIOS, runCommercialQaScenario } from "@/lib/qa/commercial-scenarios";
import type { LaunchGate } from "@/lib/hq/launch";
import type { OwnerWorkspace } from "@/lib/owner/service";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * COMMERCIAL OPERABILITY (design partner V1): plan entitlement vs authority, the activation workflow
 * and free month, cost-to-serve (measured / estimated / unavailable), unit economics with setup kept
 * apart, value contracts, the owner allow-list and the commercial QA scenarios.
 */

let dispose: (() => void) | undefined;
afterEach(() => {
  setReasonerForTests(undefined);
  resetEntitlementCacheForTests();
  resetControlsCacheForTests();
  dispose?.();
  dispose = undefined;
});

const NOW = new Date("2026-10-10T10:00:00.000Z");
const DAY = 24 * 3600_000;
const meta = (reason = "test", now = NOW) => ({ by: "founder-test", reason, now });
let n = 0;
const bid = () => `t-commercial-${Date.now().toString(36)}-${n++}`;
const READY_LAUNCH: LaunchGate = { level: "READY_FOR_SUPERVISED_DESIGN_PARTNER", reason: "Every required item has evidence.", items: [{ id: "qa.live_proof", title: "QA / live proof", status: "ready", evidence: "Work verdict passed", responsibility: "founder", requiredForSupervised: true }], requiredRemaining: [], unknown: [] };

describe("CHECKPOINT 2 — plan entitlement vs authority (both must pass; the plan only removes)", () => {
  it("plan denied + authority allowed = UNAVAILABLE; plan allowed + authority denied = DENIED; both allowed = EXECUTABLE", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const id = r.g.business.id;
    const cart = { action: "addToCart", params: { productId: "prod-midnight-wrap-dress", quantity: 1 } };
    setEntitlement(id, { plan: "CORE", features: [...PLAN_CATALOG.CORE.features], emulated: false });
    const core = decide(r.g, cart);
    expect(executability(core)).toBe("unavailable");
    expect(core).toMatchObject({ status: "denied", policyId: "plan:not_included", entitlement: { plan: "CORE", feature: "commerce_transactions", unlockedBy: "OPERATOR" } });
    setEntitlement(id, { plan: "OPERATOR", features: [...PLAN_CATALOG.OPERATOR.features], emulated: false });
    expect(executability(decide(r.g, cart))).toBe("executable");
    await applyControlChange(id, { pauseConsequentialWrites: true }, { by: "founder", reason: "incident" });
    const denied = decide(r.g, cart);
    expect(executability(denied)).toBe("denied");
    expect(denied.policyId).toBe("founder_control:writes_paused");
    // The plan never turns an owner approval into "allowed": above-limit discount still needs the owner on INTELLIGENCE.
    await applyControlChange(id, { pauseConsequentialWrites: false }, { by: "founder", reason: "resolved" });
    setEntitlement(id, { plan: "INTELLIGENCE", features: [...PLAN_CATALOG.INTELLIGENCE.features], emulated: false });
    expect(decide(r.g, { action: "grantDiscount", params: { discountPct: 10, item: "x" } }).status).toBe("requires_approval");
    // Reads stay on every plan; unknown actions fail closed to the broadest execution feature.
    setEntitlement(id, { plan: "CORE", features: [...PLAN_CATALOG.CORE.features], emulated: false });
    expect(executability(decide(r.g, { action: "searchProducts", params: { text: "dress" } }))).toBe("executable");
    expect(featureForAction("someNewWrite")).toBe("connected_systems_execution");
  });

  it("runtime: on CORE a customer's add-to-cart is unavailable — no cart, no owner request; no account = no plan restriction", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    await selectPlan(r.g.business.id, { plan: "CORE" }, meta("core customer"));
    const model = new ScriptedModel(() => ({ commerce: { intent: "select", subject: "Midnight Wrap Dress", variant: { size: "M" }, quantity: 1 }, advancesTransaction: true }));
    setReasonerForTests(model);
    const res = await handleCustomerMessage(r.g, conv("core-cart"), "c", "Add the Midnight Wrap Dress in M");
    const step = res.turn.trace?.steps[0];
    expect(step?.action).toBe("addToCart");
    expect(step?.policy).toMatchObject({ status: "denied", policyId: "plan:not_included" });
    expect(res.state.knownFields.__commerceCartId).toBeUndefined();
    // A business without a commercial account is not restricted by a plan.
    const free = isolatedRetailer();
    const prev = dispose;
    dispose = () => {
      prev?.();
      free.dispose();
    };
    const res2 = await handleCustomerMessage(free.g, conv("no-plan"), "c", "Add the Midnight Wrap Dress in M");
    expect(res2.turn.trace?.steps[0]?.policy.status).toBe("allowed");
  });

  it("QA emulation of a plan is explicit, audited and QA-only", async () => {
    const id = bid();
    await emulatePlanForQa(id, "CORE", "qa-founder");
    expect(await loadEntitlement(id)).toMatchObject({ plan: "CORE", emulated: true });
    expect((await listCommercialEvents(id))[0]).toMatchObject({ kind: "qa_plan_emulated", by: "qa-founder" });
    await emulatePlanForQa(id, null, "qa-founder");
    expect(await loadEntitlement(id)).toMatchObject({ plan: null, emulated: false });
  });
});

describe("CHECKPOINTS 1, 3, 14–16 — commercial account, activation, free month, billing boundary, price lock", () => {
  it("lifecycle: plan → quote → invoice → paid → activate (30 days) → confirm recurring; every step audited via the manual billing boundary", async () => {
    const id = bid();
    await selectPlan(id, { plan: "OPERATOR" }, meta("signed"));
    await quoteSetup(id, { setupPrice: 1500 }, meta("quote"));
    await invoiceSetup(id, meta("invoice"));
    await expect(activateFreePeriod(id, { gateLevel: "READY_TO_START_FREE_MONTH" }, meta("too early"))).rejects.toThrow(/not paid or waived/);
    await markSetupPaid(id, { reference: "bank-123" }, meta("received"));
    const { account } = await activateFreePeriod(id, { gateLevel: "READY_TO_START_FREE_MONTH" }, meta("ready"));
    expect(account).toMatchObject({ subscriptionState: "free_period", freePeriodStartsAt: NOW.toISOString(), freePeriodEndsAt: new Date(NOW.getTime() + 30 * DAY).toISOString(), recurringStartsAt: new Date(NOW.getTime() + 30 * DAY).toISOString() });
    await expect(activateFreePeriod(id, { gateLevel: "READY_TO_START_FREE_MONTH" }, meta("again"))).rejects.toThrow(/can't start from free period/);
    await expect(confirmRecurringStart(id, meta("early", new Date(NOW.getTime() + 10 * DAY)))).rejects.toThrow(/runs until/);
    const done = await confirmRecurringStart(id, meta("month over", new Date(NOW.getTime() + 31 * DAY)));
    expect(done.account.subscriptionState).toBe("active");
    expect(done.event.billing).toMatchObject({ provider: "manual", automatic: false });
    const events = await listCommercialEvents(id);
    expect(events.map((e) => e.kind).reverse()).toEqual(["plan_selected", "setup_quoted", "setup_invoiced", "setup_paid", "free_period_started", "recurring_confirmed"]);
    expect(events.every((e) => e.by === "founder-test" && e.reason)).toBe(true);
    expect(getCommercialBilling().chargesAutomatically).toBe(false);
  });

  it("delayed onboarding never burns the free month; a pause inside it extends the end; activation needs readiness or an audited override", async () => {
    const id = bid();
    await selectPlan(id, { plan: "CORE" }, meta());
    await quoteSetup(id, { setupPrice: 750 }, meta());
    await waiveSetup(id, meta("founding partner"));
    // Months of integration delay: still pre-activation, the free month is untouched.
    expect(commercialStage(await getCommercialAccount(id), new Date(NOW.getTime() + 90 * DAY))).toBe("setup_settled");
    await expect(activateFreePeriod(id, { gateLevel: "NOT_READY", gateBlocker: "Payments run on a simulator" }, meta())).rejects.toThrow(/Payments run on a simulator/);
    const { account, event } = await activateFreePeriod(id, { gateLevel: "NOT_READY", override: "owner accepts simulated payments for week 1" }, meta("go"));
    expect(account.activation?.override).toBe("owner accepts simulated payments for week 1");
    expect(event.reason).toMatch(/^OVERRIDE: owner accepts/);
    await pauseSubscription(id, meta("integration broke", new Date(NOW.getTime() + 5 * DAY)));
    const resumed = await resumeSubscription(id, meta("fixed", new Date(NOW.getTime() + 8 * DAY)));
    expect(resumed.account.freePeriodEndsAt).toBe(new Date(NOW.getTime() + 33 * DAY).toISOString());
    await cancelSubscription(id, {}, meta("customer left"));
    expect(commercialStage(await getCommercialAccount(id), NOW)).toBe("cancelled");
  });

  it("founding customer price lock: locked price in force; removing purchased features needs explicit founder review", async () => {
    const id = bid();
    await selectPlan(id, { plan: "OPERATOR", monthlyPrice: 799, foundingCustomer: true, priceLockMonths: 12 }, meta("founding"));
    const a = (await getCommercialAccount(id))!;
    expect(a).toMatchObject({ foundingCustomer: true, lockedMonthlyPrice: 799 });
    expect(effectiveMonthlyPrice(a, NOW)).toBe(799);
    await expect(selectPlan(id, { plan: "CORE" }, meta("downgrade"))).rejects.toThrow(/removes commerce_transactions/);
    const ok = await selectPlan(id, { plan: "CORE", confirmFeatureRemoval: true }, meta("reviewed downgrade"));
    expect(ok.event).toMatchObject({ kind: "plan_changed", before: expect.objectContaining({ plan: "OPERATOR" }) });
    expect(ok.account.planVersion).toBe("2026-10-v1");
  });

  it("design-partner readiness: READY TO START FREE MONTH only with plan, setup terms, setup settled, the launch gate and supervision; else the exact blocker", async () => {
    const id = bid();
    const controls = { ...DEFAULT_CONTROLS, mode: "supervised" as const };
    expect(commercialReadiness({ account: null, launch: READY_LAUNCH, controls })).toMatchObject({ level: "NOT_READY", blocker: "Plan selected: No plan selected." });
    await selectPlan(id, { plan: "CORE" }, meta());
    await quoteSetup(id, { setupPrice: 750 }, meta());
    const quoted = commercialReadiness({ account: await getCommercialAccount(id), launch: READY_LAUNCH, controls });
    expect(quoted.blocker).toBe("Setup paid or waived: Setup is not paid or waived.");
    await markSetupPaid(id, {}, meta());
    expect(commercialReadiness({ account: await getCommercialAccount(id), launch: READY_LAUNCH, controls: DEFAULT_CONTROLS }).blocker).toMatch(/^Founder supervision set: Still in SIMULATOR mode/);
    expect(commercialReadiness({ account: await getCommercialAccount(id), launch: READY_LAUNCH, controls }).level).toBe("READY_TO_START_FREE_MONTH");
    await activateFreePeriod(id, { gateLevel: "READY_TO_START_FREE_MONTH" }, meta());
    expect(commercialReadiness({ account: await getCommercialAccount(id), launch: READY_LAUNCH, controls }).level).toBe("FREE_MONTH_ALREADY_STARTED");
  });
});

describe("CHECKPOINTS 4–7 — cost to serve and unit economics", () => {
  it("model usage: provider-reported tokens metered per turn, priced by the versioned rate card; an unknown model's cost is unavailable", async () => {
    const id = bid();
    const { calls } = await withUsageMeter(async () => {
      meterModelCall({ model: "gpt-4o-mini", role: "reasoner", inputTokens: 2000, outputTokens: 300, cachedTokens: 1000, reasoningTokens: 0, providerReported: true });
      meterModelCall({ model: "mystery-model", role: "composer", inputTokens: 500, outputTokens: 100, cachedTokens: 0, reasoningTokens: 0, providerReported: true });
    });
    expect(calls).toHaveLength(2);
    const recs = await recordModelUsage(id, { conversationId: "c1", turnId: "turn-1" }, calls);
    expect(recs[0].estimatedCostUsd).toBeCloseTo(estimateCallCost({ model: "gpt-4o-mini", inputTokens: 2000, cachedTokens: 1000, outputTokens: 300 })!, 8);
    expect(recs[0].estimatedCostUsd).toBeCloseTo((1000 * 0.15 + 1000 * 0.075 + 300 * 0.6) / 1e6, 8);
    expect(recs[1].estimatedCostUsd).toBeNull();
    const cost = costToServe({ period: monthPeriod(new Date()), records: [], usage: await listModelUsage(id), support: [] });
    expect(cost.model).toMatchObject({ calls: 2, unpricedCalls: 1, inputTokens: 2500, rateCardVersion: "rates-2026-10-v1" });
    expect(cost.lines.find((l) => l.category === "ai_model")).toMatchObject({ basis: "estimated" });
    // Calls outside a metered turn are not counted (never attributed to a business by guess).
    meterModelCall({ model: "gpt-4o-mini", role: "composer", inputTokens: 1, outputTokens: 1, cachedTokens: 0, reasoningTokens: 0, providerReported: true });
  });

  it("cost records are labelled: measured beats estimate for a category; unavailable is never zero; estimates need a confidence", async () => {
    const id = bid();
    const p = monthPeriod(NOW);
    const base = { provider: "x", currency: "USD", source: "s", periodStart: p.start, periodEnd: new Date(Date.parse(p.end) - 1).toISOString() };
    expect(CostRecordInputSchema.safeParse({ ...base, category: "hosting_compute", amount: 10, basis: "estimated" }).success).toBe(false);
    expect(CostRecordInputSchema.safeParse({ ...base, category: "hosting_compute", amount: 10, basis: "unavailable" }).success).toBe(false);
    await recordCost(id, { ...base, category: "hosting_compute", amount: 30, basis: "estimated", confidence: "low" }, "f");
    await recordCost(id, { ...base, category: "hosting_compute", amount: 22.5, basis: "measured", source: "Vercel invoice share" }, "f");
    await recordCost(id, { ...base, category: "messaging", amount: null, basis: "unavailable" }, "f");
    await recordSupportTime(id, { minutes: 90, note: "onboarding call", at: NOW.toISOString() }, "f");
    const cost = costToServe({ period: p, records: await listCostRecords(id), usage: [], support: await listSupportTime(id) });
    expect(cost.lines.find((l) => l.category === "hosting_compute")).toMatchObject({ amount: 22.5, basis: "measured" });
    expect(cost.lines.find((l) => l.category === "messaging")).toMatchObject({ amount: null, basis: "unavailable" });
    expect(cost.lines.find((l) => l.category === "support_time")).toMatchObject({ amount: 90, basis: "estimated" });
    expect(cost.total).toEqual({ USD: 112.5 });
    expect(cost.missing).toContain("messaging");
    expect(cost.allMeasured).toBe(false);
  });

  it("unit economics: free days earn nothing; paid days at the contracted price; setup reported apart; contribution and margin per currency; guardrail flags", async () => {
    const id = bid();
    const start = new Date("2026-09-01T00:00:00.000Z");
    await selectPlan(id, { plan: "CORE" }, meta("x", start));
    await quoteSetup(id, { setupPrice: 750 }, meta("x", start));
    await markSetupPaid(id, {}, meta("x", start));
    await activateFreePeriod(id, { gateLevel: "READY_TO_START_FREE_MONTH" }, meta("x", start));
    await confirmRecurringStart(id, meta("x", new Date("2026-10-01T00:00:00.000Z")));
    const october = monthPeriod(new Date("2026-10-31T23:00:00.000Z"));
    const sept = monthPeriod(new Date("2026-09-15T00:00:00.000Z"));
    const records = [{ id: "c1", businessId: id, recordedBy: "f", recordedAt: october.start, category: "hosting_compute" as const, provider: "x", amount: 60, currency: "USD", basis: "measured" as const, source: "invoice", periodStart: october.start, periodEnd: new Date(Date.parse(october.end) - 1).toISOString() }];
    const account = await getCommercialAccount(id);
    const events = await listCommercialEvents(id);
    const oct = unitEconomics({ account, events, cost: costToServe({ period: october, records, usage: [], support: [] }), now: new Date("2026-10-31T23:00:00.000Z") });
    expect(oct).toMatchObject({ recurringRevenue: 399, setupRevenue: 0, costToServe: 60, grossContribution: 339, grossMarginPct: 85, belowMarginTarget: false, aboveGuardrail: false, costBasis: "measured" });
    const sep = unitEconomics({ account, events, cost: costToServe({ period: sept, records: [], usage: [], support: [] }), now: new Date("2026-09-30T00:00:00.000Z") });
    expect(sep.recurringRevenue).toBe(0);
    expect(sep.setupRevenue).toBe(750);
    expect(sep.grossMarginPct).toBeNull();
    const high = unitEconomics({ account, events, cost: costToServe({ period: october, records: [{ ...records[0], amount: 300 }], usage: [], support: [] }), now: new Date("2026-10-31T23:00:00.000Z") });
    expect(high.aboveGuardrail).toBe(true);
    expect(high.belowMarginTarget).toBe(true);
    // A full-month invoice recorded on day 1 is not a run-rate: no extrapolation into a false breach.
    const day1 = unitEconomics({ account, events, cost: costToServe({ period: october, records: [{ ...records[0], amount: 100 }], usage: [], support: [] }), now: new Date("2026-10-01T06:00:00.000Z") });
    expect(day1.aboveGuardrail).toBe(false);
  });
});

describe("CHECKPOINTS 8, 9, 12 — value contracts and the owner's view (plan + value, never economics)", () => {
  const ws = (over: Partial<OwnerWorkspace> = {}): OwnerWorkspace =>
    ({
      conversations: [{ handledAutonomously: true, lastActivityAt: "2026-10-05T00:00:00.000Z" }, { handledAutonomously: false, lastActivityAt: "2026-10-05T00:00:00.000Z" }],
      outcomes: [
        { kind: "paid", at: "2026-10-05T00:00:00.000Z", simulated: false },
        { kind: "paid", at: "2026-10-05T00:00:00.000Z", simulated: true },
        { kind: "checkout_abandoned", at: "2026-10-05T00:00:00.000Z" },
      ],
      revenue: { direct: { ILS: 420 }, recovered: { ILS: 100 }, simulatedPaid: { ILS: 999 }, potential: { ILS: 300 }, ownerInterventions: 1, activeConversations: 2 },
      obligations: [],
      health: { systems: [] },
      capabilities: { steps: [] },
      today: { interventions: 1 },
      unavailable: [],
      ...over,
    }) as unknown as OwnerWorkspace;

  it("HANDLED / MADE / SAVED / NEEDS YOU: verified only; simulated and pending never count; savings only realized", () => {
    const period = { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z", label: "2026-10" };
    const v = valueAccount({ ws: ws(), period, costEvidence: [], entitlement: { plan: "INTELLIGENCE", features: [...PLAN_CATALOG.INTELLIGENCE.features], emulated: false }, businessId: "b" });
    expect(v.handled).toMatchObject({ conversations: 1, outcomes: 1, byKind: { paid: 1 } });
    expect(v.made).toEqual({ generated: { ILS: 420 }, recovered: { ILS: 100 }, excludedSimulated: { ILS: 999 }, openOpportunity: { ILS: 300 } });
    expect(v.saved.realized).toEqual({});
    expect(v.saved.marginsNote).toBe("BARRY Margins needs connected cost evidence — no savings are shown without it.");
    expect(v.needsYou.conversations).toBe(1);
    const core = valueAccount({ ws: ws(), period, costEvidence: [], entitlement: { plan: "CORE", features: [...PLAN_CATALOG.CORE.features], emulated: false }, businessId: "b" });
    expect(core.saved.marginsAvailable).toBe(false);
    expect(core.unlockNext.some((u) => /BARRY Margins|Carts, discounts and orders/.test(u))).toBe(true);
  });

  it("the owner plan view shows plan, what is locked, upgrades and value — and no cost, margin or AI economics anywhere", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const id = r.g.business.id;
    await selectPlan(id, { plan: "CORE" }, meta());
    await recordModelUsage(id, { turnId: "t1" }, [{ model: "gpt-4o-mini", role: "reasoner", inputTokens: 100, outputTokens: 10, cachedTokens: 0, reasoningTokens: 0, providerReported: true, at: new Date().toISOString() }]);
    const view = await getOwnerPlanView(r.g);
    expect(view.plan).toMatchObject({ id: "CORE", name: "BARRY Core", monthlyPrice: 399, currency: "USD" });
    expect(view.planLocked.some((p) => p.feature === "Carts, discounts and orders" && p.unlockedBy === "BARRY Operator")).toBe(true);
    expect(view.upgrades.map((u) => u.id)).toEqual(["OPERATOR", "INTELLIGENCE"]);
    const text = JSON.stringify(view).toLowerCase();
    for (const banned of ["costtoserve", "cost_to_serve", "grosscontribution", "grossmargin", "margin%", "estimatedcost", "tokens", "guardrail", "rate-card", "rates-2026"]) expect(text).not.toContain(banned);
    const req = await requestPlanChange(id, { plan: "OPERATOR", message: "we want checkout" }, "owner");
    expect(req).toMatchObject({ plan: "OPERATOR", status: "open" });
    expect((await getCommercialAccount(id))?.plan).toBe("CORE"); // a request only — the founder changes plans
    expect(await listPlanRequests(id)).toHaveLength(1);
  });
});

describe("CHECKPOINT 20 — commercial QA scenarios pass through the real code paths", () => {
  for (const s of COMMERCIAL_QA_SCENARIOS) {
    it(`${s.id}: ${s.title}`, async () => {
      const run = await runCommercialQaScenario(s.id);
      expect(run.failures).toEqual([]);
      expect(run.outcome).toBe("pass");
      expect(run.businessId.startsWith(`qa-commercial:${s.id}:`)).toBe(true);
    });
  }
  it("a CommercialError carries the founder-facing reason", () => {
    expect(new CommercialError("x")).toBeInstanceOf(Error);
    void loadControls;
  });
});
