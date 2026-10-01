import { describe, expect, it } from "vitest";
import { RATE_CARDS, currentRateCard, estimateCallCost, rateFor } from "@/lib/commercial/rate-card";
import { listModelUsage, recordModelUsage } from "@/lib/commercial/cost";
import type { ModelCall } from "@/lib/commercial/usage-meter";

/** The live Rina turn: gpt-5.6-sol, provider-reported, 5548 in / 355 out (61 reasoning, included in output). */
const call = (over: Partial<ModelCall> = {}): ModelCall => ({ model: "gpt-5.6-sol", role: "reasoner", inputTokens: 5548, outputTokens: 355, cachedTokens: 0, reasoningTokens: 61, providerReported: true, at: "2026-10-02T10:00:00.000Z", ...over }) as ModelCall;

describe("rate card v2 — gpt-5.6-sol", () => {
  it("is a NEW version; v1 is untouched and still has no rate for it (history stays attributable)", () => {
    expect(RATE_CARDS.map((c) => c.version)).toEqual(["rates-2026-10-v1", "rates-2026-10-v2"]);
    expect(currentRateCard().version).toBe("rates-2026-10-v2");
    expect(currentRateCard().effectiveFrom).toBe("2026-10-02");
    expect(rateFor("gpt-5.6-sol", RATE_CARDS[0])).toBeUndefined();
    expect(estimateCallCost(call(), RATE_CARDS[0])).toBeUndefined();
  });

  it("prices gpt-5.6-sol at the official Standard short-context rates ($4 in / $0.40 cached / $20 out per 1M)", () => {
    expect(rateFor("gpt-5.6-sol")).toEqual({ input: 4, cachedInput: 0.4, output: 20 });
    // 5548 × 4 + 355 × 20 = 29,292 → $0.029292
    expect(estimateCallCost(call())).toBeCloseTo(0.029292, 9);
  });

  it("applies cached-input pricing to the cached share only", () => {
    // (5548 − 4000) × 4 + 4000 × 0.4 + 355 × 20 = 14,892 → $0.014892
    expect(estimateCallCost(call({ cachedTokens: 4000 }))).toBeCloseTo(0.014892, 9);
  });

  it("existing known models are priced exactly as before; unknown models stay unavailable", () => {
    expect(estimateCallCost({ model: "gpt-4o-mini", inputTokens: 1000, cachedTokens: 0, outputTokens: 500 })).toBeCloseTo((1000 * 0.15 + 500 * 0.6) / 1e6, 12);
    expect(estimateCallCost({ model: "gpt-5", inputTokens: 1000, cachedTokens: 200, outputTokens: 100 })).toBeCloseTo((800 * 1.25 + 200 * 0.125 + 100 * 10) / 1e6, 12);
    for (const rates of [RATE_CARDS[0].rates, RATE_CARDS[1].rates]) expect(rates["gpt-4o-mini"]).toEqual({ input: 0.15, cachedInput: 0.075, output: 0.6 });
    for (const m of ["gpt-5.7-sol", "gpt-5.6", "some-future-model", "gpt-5.6-terra"]) expect(estimateCallCost({ model: m, inputTokens: 100, cachedTokens: 0, outputTokens: 10 })).toBeUndefined();
  });

  it("stored usage: a NEW gpt-5.6-sol call gets an estimate tagged v2; unknown / not provider-reported stay null (no fabricated cost)", async () => {
    const biz = `rate-card-${Date.now()}`;
    const [sol, unknown, unreported] = await recordModelUsage(biz, { conversationId: "c1", turnId: "t1" }, [call(), call({ model: "mystery-model" }), call({ providerReported: false })]);
    expect(sol).toMatchObject({ model: "gpt-5.6-sol", providerReported: true, rateCardVersion: "rates-2026-10-v2", reasoningTokens: 61 });
    expect(sol.estimatedCostUsd).toBeCloseTo(0.029292, 6);
    expect(unknown.estimatedCostUsd).toBeNull();
    expect(unreported.estimatedCostUsd).toBeNull();
    expect((await listModelUsage(biz)).map((u) => u.estimatedCostUsd)).toEqual(expect.arrayContaining([sol.estimatedCostUsd, null]));
  });

  it("history is not rewritten: a v1 record with a null cost stays null when read (aggregation uses the stored cost)", async () => {
    const { getBackend } = await import("@/lib/store");
    const { costToServe, monthPeriod } = await import("@/lib/commercial/cost");
    const biz = `rate-card-hist-${Date.now()}`;
    const old = { id: "old:0", businessId: biz, conversationId: null, turnId: null, at: "2026-10-01T09:00:00.000Z", model: "gpt-5.6-sol", role: "reasoner", inputTokens: 5548, outputTokens: 355, cachedTokens: 0, reasoningTokens: 61, providerReported: true, rateCardVersion: "rates-2026-10-v1", estimatedCostUsd: null };
    await getBackend().upsertOperatorRecord({ businessId: biz, kind: "model_usage", key: old.id, data: old as unknown as Record<string, unknown> });
    const usage = await listModelUsage(biz);
    expect(usage[0].estimatedCostUsd).toBeNull();
    expect(usage[0].rateCardVersion).toBe("rates-2026-10-v1");
    const cost = costToServe({ period: monthPeriod(new Date("2026-10-15T00:00:00Z")), records: [], usage, support: [] });
    expect(cost.model.unpricedCalls).toBe(1);
    expect(cost.model.estimatedUsd).toBe(0);
  });
});
