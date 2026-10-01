import { z } from "zod";
import { getBackend } from "@/lib/store";
import { currentRateCard, estimateCallCost } from "./rate-card";
import type { ModelCall } from "./usage-meter";

/**
 * COST TO SERVE — what one business costs BARRY, provider-independent. Three sources:
 *   - cost records: an amount the founder / a system recorded for a category and period, labelled
 *     MEASURED (an invoice / provider bill), ESTIMATED (with a confidence) or UNAVAILABLE (known to
 *     exist, amount unknown). Infra bills are never faked: no record means "unavailable", not zero.
 *   - model usage: provider-reported tokens per turn (MEASURED usage) priced with the versioned
 *     internal rate card (ESTIMATED cost). A model without a rate has an unavailable cost.
 *   - support time: founder / support minutes × an internal hourly cost assumption (ESTIMATED).
 * Founder / server only. The owner never sees any of it.
 */

export const COST_CATEGORIES = ["ai_model", "ai_other", "database_storage", "hosting_compute", "messaging", "external_provider", "support_time", "integration_maintenance"] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];
export type CostBasis = "measured" | "estimated" | "unavailable";

export const CATEGORY_WORDS: Record<CostCategory, string> = {
  ai_model: "AI reasoner / composer",
  ai_other: "Embeddings / other model usage",
  database_storage: "Database / storage",
  hosting_compute: "Hosting / compute allocation",
  messaging: "Messaging / channel fees",
  external_provider: "External provider fees BARRY pays",
  support_time: "Support / founder time",
  integration_maintenance: "Integration maintenance",
};

export const CostRecordInputSchema = z
  .object({
    category: z.enum(COST_CATEGORIES),
    provider: z.string().min(1).max(100),
    amount: z.number().nonnegative().nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    basis: z.enum(["measured", "estimated", "unavailable"]),
    source: z.string().min(1).max(300),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    usageQuantity: z.number().nonnegative().optional(),
    usageUnit: z.string().max(40).optional(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
    note: z.string().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.basis === "unavailable" && v.amount !== null) ctx.addIssue({ code: "custom", message: "An unavailable cost has no amount", path: ["amount"] });
    if (v.basis !== "unavailable" && v.amount === null) ctx.addIssue({ code: "custom", message: "A measured or estimated cost needs an amount", path: ["amount"] });
    if (v.basis === "estimated" && !v.confidence) ctx.addIssue({ code: "custom", message: "An estimate needs a confidence", path: ["confidence"] });
    if (v.periodEnd < v.periodStart) ctx.addIssue({ code: "custom", message: "The period ends before it starts", path: ["periodEnd"] });
  });

export type CostRecordInput = z.infer<typeof CostRecordInputSchema>;
export type CostRecord = CostRecordInput & { id: string; businessId: string; recordedBy: string; recordedAt: string };

export type ModelUsageRecord = {
  id: string;
  businessId: string;
  conversationId: string | null;
  turnId: string | null;
  at: string;
  model: string;
  role: ModelCall["role"];
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  providerReported: boolean;
  rateCardVersion: string;
  /** USD; null = no rate for this model (cost unavailable, never guessed). */
  estimatedCostUsd: number | null;
};

export type SupportTimeRecord = { id: string; businessId: string; at: string; by: string; minutes: number; note: string; hourlyCostUsd: number; estimatedCostUsd: number };

const rid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** The internal hourly cost of founder / support time — an ASSUMPTION (env BARRY_SUPPORT_HOURLY_COST_USD). */
export function supportHourlyCostUsd(): number {
  const v = Number(process.env.BARRY_SUPPORT_HOURLY_COST_USD);
  return Number.isFinite(v) && v > 0 ? v : 60;
}

export async function recordCost(businessId: string, input: unknown, by: string): Promise<CostRecord> {
  const parsed = CostRecordInputSchema.parse(input);
  const record: CostRecord = { ...parsed, id: rid("cost"), businessId, recordedBy: by, recordedAt: new Date().toISOString() };
  await getBackend().upsertOperatorRecord({ businessId, kind: "cost_record", key: record.id, data: record as unknown as Record<string, unknown> });
  return record;
}

export async function listCostRecords(businessId: string): Promise<CostRecord[]> {
  return (await getBackend().listOperatorRecords(businessId, "cost_record")).map((r) => r.data as unknown as CostRecord);
}

/** Persist the model calls one turn made (best effort: a failure is logged, never breaks the turn). */
export async function recordModelUsage(businessId: string, ref: { conversationId?: string; turnId?: string }, calls: ModelCall[]): Promise<ModelUsageRecord[]> {
  if (calls.length === 0) return [];
  const card = currentRateCard();
  const records: ModelUsageRecord[] = calls.map((c, i) => {
    const cost = c.providerReported ? estimateCallCost(c, card) : undefined;
    return {
      id: `${ref.turnId ?? rid("call")}:${i}`,
      businessId,
      conversationId: ref.conversationId ?? null,
      turnId: ref.turnId ?? null,
      at: c.at,
      model: c.model,
      role: c.role,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      cachedTokens: c.cachedTokens,
      reasoningTokens: c.reasoningTokens,
      providerReported: c.providerReported,
      rateCardVersion: card.version,
      estimatedCostUsd: cost === undefined ? null : Math.round(cost * 1_000_000) / 1_000_000,
    };
  });
  try {
    const backend = getBackend();
    for (const r of records) await backend.upsertOperatorRecord({ businessId, kind: "model_usage", key: r.id, data: r as unknown as Record<string, unknown> });
  } catch (err) {
    console.error("[barry:cost] model usage not recorded", err instanceof Error ? err.message : err);
  }
  return records;
}

export async function listModelUsage(businessId: string): Promise<ModelUsageRecord[]> {
  return (await getBackend().listOperatorRecords(businessId, "model_usage")).map((r) => r.data as unknown as ModelUsageRecord);
}

export async function recordSupportTime(businessId: string, input: { minutes: number; note?: string; at?: string }, by: string): Promise<SupportTimeRecord> {
  if (!(input.minutes > 0 && input.minutes <= 24 * 60)) throw new Error("Minutes must be between 1 and 1440");
  const hourly = supportHourlyCostUsd();
  const record: SupportTimeRecord = { id: rid("sup"), businessId, at: input.at ?? new Date().toISOString(), by, minutes: Math.round(input.minutes), note: (input.note ?? "").slice(0, 300), hourlyCostUsd: hourly, estimatedCostUsd: Math.round(((input.minutes / 60) * hourly) * 100) / 100 };
  await getBackend().upsertOperatorRecord({ businessId, kind: "support_time", key: record.id, data: record as unknown as Record<string, unknown> });
  return record;
}

export async function listSupportTime(businessId: string): Promise<SupportTimeRecord[]> {
  return (await getBackend().listOperatorRecords(businessId, "support_time")).map((r) => r.data as unknown as SupportTimeRecord);
}

// ── Aggregation (pure) ───────────────────────────────────────────────────────────────────────────

export type Period = { start: string; end: string; label: string };

/** A calendar month (UTC) containing `now`. */
export function monthPeriod(now = new Date()): Period {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString(), label: start.toISOString().slice(0, 7) };
}

export type CostLine = {
  category: CostCategory;
  label: string;
  /** null when unavailable. */
  amount: number | null;
  currency: string;
  basis: CostBasis;
  /** Why this number (records, calls, minutes). */
  detail: string;
};

export type CostToServe = {
  period: Period;
  lines: CostLine[];
  /** Sum of the known amounts per currency (unavailable lines add nothing and are listed in `missing`). */
  total: Record<string, number>;
  /** Categories with no amount for this period — the total is a LOWER BOUND while any remain. */
  missing: CostCategory[];
  /** True when every amount in the total is measured. */
  allMeasured: boolean;
  model: { calls: number; unpricedCalls: number; inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number; estimatedUsd: number; byModel: Record<string, { calls: number; estimatedUsd: number }>; rateCardVersion: string };
  supportMinutes: number;
};

const inPeriod = (at: string, p: Period) => at >= p.start && at < p.end;
const overlaps = (r: { periodStart: string; periodEnd: string }, p: Period) => r.periodStart < p.end && r.periodEnd >= p.start;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Cost to serve one business in one period. A MEASURED record for a category replaces the estimate of
 * that category (an invoice allocation beats a rate-card estimate) — never both.
 */
export function costToServe(input: { period: Period; records: CostRecord[]; usage: ModelUsageRecord[]; support: SupportTimeRecord[] }): CostToServe {
  const { period } = input;
  const records = input.records.filter((r) => overlaps(r, period));
  const usage = input.usage.filter((u) => inPeriod(u.at, period));
  const support = input.support.filter((s) => inPeriod(s.at, period));
  const lines: CostLine[] = [];
  const model = { calls: usage.length, unpricedCalls: usage.filter((u) => u.estimatedCostUsd === null).length, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, estimatedUsd: 0, byModel: {} as Record<string, { calls: number; estimatedUsd: number }>, rateCardVersion: currentRateCard().version };
  for (const u of usage) {
    model.inputTokens += u.inputTokens;
    model.outputTokens += u.outputTokens;
    model.cachedTokens += u.cachedTokens;
    model.reasoningTokens += u.reasoningTokens;
    model.estimatedUsd += u.estimatedCostUsd ?? 0;
    const m = (model.byModel[u.model] ??= { calls: 0, estimatedUsd: 0 });
    m.calls++;
    m.estimatedUsd += u.estimatedCostUsd ?? 0;
  }
  model.estimatedUsd = Math.round(model.estimatedUsd * 10000) / 10000;
  for (const m of Object.values(model.byModel)) m.estimatedUsd = Math.round(m.estimatedUsd * 10000) / 10000;

  for (const category of COST_CATEGORIES) {
    const recs = records.filter((r) => r.category === category);
    const measured = recs.filter((r) => r.basis === "measured");
    if (measured.length) {
      const byCur = new Map<string, number>();
      for (const r of measured) byCur.set(r.currency, (byCur.get(r.currency) ?? 0) + (r.amount ?? 0));
      for (const [currency, amount] of byCur) lines.push({ category, label: CATEGORY_WORDS[category], amount: r2(amount), currency, basis: "measured", detail: `${measured.length} measured record${measured.length === 1 ? "" : "s"} (${[...new Set(measured.map((r) => r.provider))].join(", ")})` });
      continue;
    }
    if (category === "ai_model" && usage.length) {
      lines.push({ category, label: CATEGORY_WORDS[category], amount: Math.round(model.estimatedUsd * 100) / 100, currency: "USD", basis: "estimated", detail: `${usage.length} model call${usage.length === 1 ? "" : "s"}, ${model.inputTokens + model.outputTokens} tokens (provider-reported) × ${model.rateCardVersion}${model.unpricedCalls ? `; ${model.unpricedCalls} call(s) on a model without a rate are not priced` : ""}` });
      continue;
    }
    if (category === "support_time" && support.length) {
      const minutes = support.reduce((s, x) => s + x.minutes, 0);
      lines.push({ category, label: CATEGORY_WORDS[category], amount: r2(support.reduce((s, x) => s + x.estimatedCostUsd, 0)), currency: "USD", basis: "estimated", detail: `${minutes} min × internal ${support[0].hourlyCostUsd} USD/h assumption` });
      continue;
    }
    const estimated = recs.filter((r) => r.basis === "estimated");
    if (estimated.length) {
      const byCur = new Map<string, number>();
      for (const r of estimated) byCur.set(r.currency, (byCur.get(r.currency) ?? 0) + (r.amount ?? 0));
      for (const [currency, amount] of byCur) lines.push({ category, label: CATEGORY_WORDS[category], amount: r2(amount), currency, basis: "estimated", detail: `${estimated.length} estimate${estimated.length === 1 ? "" : "s"} (confidence ${[...new Set(estimated.map((r) => r.confidence))].join("/")})` });
      continue;
    }
    lines.push({ category, label: CATEGORY_WORDS[category], amount: null, currency: "USD", basis: "unavailable", detail: recs.length ? "recorded as unavailable" : "no record for this period" });
  }
  const total: Record<string, number> = {};
  for (const l of lines) if (l.amount !== null) total[l.currency] = r2((total[l.currency] ?? 0) + l.amount);
  const known = lines.filter((l) => l.amount !== null);
  return {
    period,
    lines,
    total,
    missing: lines.filter((l) => l.amount === null).map((l) => l.category),
    allMeasured: known.length > 0 && known.every((l) => l.basis === "measured"),
    model,
    supportMinutes: support.reduce((s, x) => s + x.minutes, 0),
  };
}
