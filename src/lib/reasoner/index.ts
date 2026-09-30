import { MockReasoner } from "./mock-reasoner";
import { OpenAIReasoner } from "./openai-reasoner";
import type { Reasoner } from "./types";
import { BarryConfigurationError, isProductionRuntime } from "@/lib/env";

export * from "./types";
export * from "./ir";
export { MockReasoner } from "./mock-reasoner";
export { OpenAIReasoner } from "./openai-reasoner";

let singleton: Reasoner | undefined;
let testOverride: Reasoner | undefined;
let qaOverride: Reasoner | undefined;

/** Test-only: run the real pipeline with a scripted/live model in place of the configured one. */
export function setReasonerForTests(reasoner: Reasoner | undefined): void {
  testOverride = reasoner;
}

/**
 * QA ONLY (the caller must check qaEnabled()): run `fn` with a scripted reasoner in place of the
 * configured one — so a QA scenario builds the same acceptance state whatever model is configured.
 * Scoped to the call; the override is cleared even when `fn` throws.
 */
export async function withQaReasoner<T>(reasoner: Reasoner, fn: () => Promise<T>): Promise<T> {
  const previous = qaOverride;
  qaOverride = reasoner;
  try {
    return await fn();
  } finally {
    qaOverride = previous;
  }
}

/**
 * Reasoner selection point. Set BARRY_REASONER=openai (with OPENAI_API_KEY)
 * to use the LLM-backed reasoner; in local dev / tests, anything else —
 * including no env vars at all — falls back to the deterministic mock.
 *
 * In a real deployment (NODE_ENV=production, which every Vercel
 * environment sets), that fallback is disabled: BARRY must never silently
 * run a customer conversation on MockReasoner because a key was missing.
 * Misconfiguration throws loudly instead.
 */
export function getReasoner(): Reasoner {
  if (testOverride) return testOverride;
  if (qaOverride) return qaOverride;
  if (singleton) return singleton;

  const configuredForOpenAI = process.env.BARRY_REASONER === "openai";

  if (isProductionRuntime()) {
    if (!configuredForOpenAI || !process.env.OPENAI_API_KEY) {
      throw new BarryConfigurationError(
        "OPENAI_API_KEY and BARRY_REASONER=openai are required in production. " +
          "Refusing to silently run customer conversations on MockReasoner."
      );
    }
  }

  singleton = configuredForOpenAI && process.env.OPENAI_API_KEY ? new OpenAIReasoner() : new MockReasoner();
  return singleton;
}
