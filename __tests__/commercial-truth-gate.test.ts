import { beforeAll, describe, expect, it } from "vitest";
import { costToServe, monthPeriod, type ModelUsageRecord } from "@/lib/commercial/cost";
import { unitEconomics } from "@/lib/commercial/economics";
import type { CommercialAccount } from "@/lib/commercial/account";
import { getCommercialAccount } from "@/lib/commercial/account";
import { POST as commercialPost } from "@/app/api/hq/commercial/route";

/**
 * COMMERCIAL TRUTH GATE — over the EXACT model-usage records persisted on Preview for Rina Studio
 * (read from Supabase on 2026-10-01: one v1 gpt-5.6-sol call with no cost, one v2 call priced 0.02938,
 * plus gpt-4o-mini composer / checker calls), and the economics rules HQ shows on top of them.
 */
const usage = (over: Partial<ModelUsageRecord>): ModelUsageRecord => ({ id: Math.random().toString(36).slice(2), businessId: "fashion-retailer", conversationId: null, turnId: null, at: "2026-10-01T18:58:19.208Z", model: "gpt-4o-mini-2024-07-18", role: "composer", inputTokens: 1000, outputTokens: 100, cachedTokens: 0, reasoningTokens: 0, providerReported: true, rateCardVersion: "rates-2026-10-v1", estimatedCostUsd: null, ...over });
const LIVE_RINA: ModelUsageRecord[] = [
  usage({ model: "gpt-5.6-sol", role: "reasoner", at: "2026-10-01T18:58:19.208Z", estimatedCostUsd: null }),
  usage({ role: "composer", at: "2026-10-01T18:58:21.690Z", estimatedCostUsd: 0.000715 }),
  usage({ role: "checker", at: "2026-10-01T18:58:22.589Z", estimatedCostUsd: 0.000046 }),
  usage({ role: "composer", at: "2026-10-01T18:59:17.833Z", estimatedCostUsd: 0.000432 }),
  usage({ model: "gpt-5.6-sol", role: "reasoner", at: "2026-10-01T23:00:57.014Z", rateCardVersion: "rates-2026-10-v2", estimatedCostUsd: 0.02938 }),
  usage({ role: "composer", at: "2026-10-01T23:00:59.609Z", rateCardVersion: "rates-2026-10-v2", estimatedCostUsd: 0.000797 }),
  usage({ role: "checker", at: "2026-10-01T23:01:00.483Z", rateCardVersion: "rates-2026-10-v2", estimatedCostUsd: 0.000054 }),
];
const OCT = monthPeriod(new Date("2026-10-15T00:00:00Z"));

describe("C. economics over the live Rina records", () => {
  const cost = costToServe({ period: OCT, records: [], usage: LIVE_RINA, support: [] });
  it("the AI line is ESTIMATED, sums the priced calls, and counts the v1 call as unpriced (never re-priced)", () => {
    const ai = cost.lines.find((l) => l.category === "ai_model")!;
    expect(ai.basis).toBe("estimated");
    expect(ai.amount).toBe(0.03); // 0.031424 rounded to cents — the "$0.03 ESTIMATED" HQ shows
    expect(cost.model.calls).toBe(7);
    expect(cost.model.unpricedCalls).toBe(1);
    expect(cost.model.estimatedUsd).toBeCloseTo(0.031424, 4);
    expect(ai.detail).toMatch(/1 call\(s\) on a model without a rate are not priced/);
  });
  it("is a LOWER BOUND: every category without a record is missing; nothing is 'measured'", () => {
    expect(cost.missing.length).toBeGreaterThan(0);
    expect(cost.missing).not.toContain("ai_model");
    expect(cost.allMeasured).toBe(false);
    const e = unitEconomics({ account: null, events: [], cost, now: new Date("2026-10-15T00:00:00Z") });
    expect(e.costComplete).toBe(false);
    expect(e.costBasis).toBe("estimated");
    expect(e.notes.join(" ")).toMatch(/lower bound/);
  });
});

describe("C. no silent zero, no silent conversion", () => {
  const account = { businessId: "x", plan: "OPERATOR", currency: "ILS", monthlyPrice: 3000, subscriptionState: "active", recurringStartsAt: "2026-09-01T00:00:00.000Z", recurringConfirmedAt: "2026-09-01T00:00:00.000Z", freePeriodStartsAt: null, freePeriodEndsAt: null, cancellationEffectiveAt: null, pausedAt: null, foundingCustomer: false, lockedMonthlyPrice: null, priceLockUntil: null, setupPrice: null, setupStatus: "waived" } as unknown as CommercialAccount;
  it("a cost recorded only in another currency leaves cost-to-serve UNAVAILABLE and contribution null — never revenue minus zero", () => {
    const cost = costToServe({ period: OCT, records: [], usage: LIVE_RINA, support: [] }); // USD only
    const e = unitEconomics({ account, events: [], cost, now: new Date("2026-10-15T00:00:00Z") });
    expect(e.recurringRevenue).toBe(3000);
    expect(e.costToServe).toBeNull();
    expect(e.grossContribution).toBeNull();
    expect(e.grossMarginPct).toBeNull();
    expect(e.notes.join(" ")).toMatch(/Costs in USD are not converted into ILS/);
  });
  it("no cost at all is UNAVAILABLE too (not 0)", () => {
    const e = unitEconomics({ account, events: [], cost: costToServe({ period: OCT, records: [], usage: [], support: [] }), now: new Date("2026-10-15T00:00:00Z") });
    expect(e.costToServe).toBeNull();
    expect(e.grossContribution).toBeNull();
    expect(e.costBasis).toBe("unavailable");
  });
});

describe("E. readiness is server-computed — the browser can't claim READY", () => {
  const TOKEN = "founder-test-token-that-is-long-enough-123456";
  beforeAll(() => {
    process.env.BARRY_FOUNDER_TOKEN = TOKEN;
  });
  const post = (body: Record<string, unknown>) => commercialPost(new Request("https://barry.example/api/hq/commercial", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }));
  it("activation recomputes the gate on the server and ignores a client-supplied 'ready'", async () => {
    const businessId = "personal-trainer";
    expect((await post({ businessId, action: "select_plan", plan: "CORE", setupPrice: 750, reason: "gate test", confirm: "yes" })).status).toBe(200);
    expect((await post({ businessId, action: "quote_setup", setupPrice: 750, reason: "gate test" })).status).toBe(200);
    expect((await post({ businessId, action: "mark_setup_paid", reason: "gate test", confirm: "yes" })).status).toBe(200);
    const claim = await post({ businessId, action: "activate_free_period", reason: "client says ready", confirm: "yes", gateLevel: "READY_TO_START_FREE_MONTH", level: "READY_TO_START_FREE_MONTH", ready: true });
    expect(claim.status).toBe(409);
    expect(((await claim.json()) as { error: string }).error).toMatch(/Not ready to start the free month/);
    expect((await getCommercialAccount(businessId))?.subscriptionState).toBe("pre_activation");
  });
  it("consequential commercial actions need a reason and an explicit confirmation", async () => {
    const r = await post({ businessId: "personal-trainer", action: "activate_free_period", reason: "x" });
    expect(r.status).toBe(400);
  });
});
