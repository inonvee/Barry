/**
 * INTERNAL MODEL COST RATE CARD — versioned ESTIMATES (USD per 1M tokens) used to price model usage
 * until the provider invoice is reconciled. A model that isn't on the card has NO estimated cost
 * ("unavailable") — never a guessed rate. Update by adding a new version; history stays readable.
 */
export type ModelRate = { input: number; cachedInput: number; output: number };

export type RateCard = { version: string; effectiveFrom: string; currency: "USD"; source: string; rates: Record<string, ModelRate> };

export const RATE_CARDS: RateCard[] = [
  {
    version: "rates-2026-10-v1",
    effectiveFrom: "2026-10-01",
    currency: "USD",
    source: "internal estimate from the provider's published list prices — verify against the monthly invoice",
    rates: {
      "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
      "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 },
      "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
      "gpt-4.1": { input: 2, cachedInput: 0.5, output: 8 },
      "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
      "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
    },
  },
  {
    // v2 ADDS gpt-5.6-sol (the primary reasoner). v1 is kept as-is so usage recorded under it stays attributable;
    // every other rate is carried over unchanged (no other model's price was re-verified in this version).
    version: "rates-2026-10-v2",
    effectiveFrom: "2026-10-02",
    currency: "USD",
    source: "internal estimate from the provider's published list prices (gpt-5.6-sol: OpenAI Standard, short context, as of 2026-10-02: https://developers.openai.com/api/docs/models/gpt-5.6-sol) — verify against the monthly invoice",
    rates: {
      "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
      "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 },
      "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
      "gpt-4.1": { input: 2, cachedInput: 0.5, output: 8 },
      "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
      "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
      "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
    },
  },
];

export function currentRateCard(): RateCard {
  return RATE_CARDS[RATE_CARDS.length - 1];
}

/** The rate for a model id (exact, then the longest known prefix, e.g. a dated snapshot of a listed model). */
export function rateFor(model: string, card: RateCard = currentRateCard()): ModelRate | undefined {
  if (card.rates[model]) return card.rates[model];
  const key = Object.keys(card.rates).filter((k) => model.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0];
  return key ? card.rates[key] : undefined;
}

/** Estimated USD cost of one call; undefined when the model has no rate (cost UNAVAILABLE, never guessed). */
export function estimateCallCost(call: { model: string; inputTokens: number; cachedTokens: number; outputTokens: number }, card: RateCard = currentRateCard()): number | undefined {
  const r = rateFor(call.model, card);
  if (!r) return undefined;
  const uncached = Math.max(0, call.inputTokens - call.cachedTokens);
  return (uncached * r.input + call.cachedTokens * r.cachedInput + call.outputTokens * r.output) / 1_000_000;
}
