import { MockReasoner } from "./mock-reasoner";
import { OpenAIReasoner } from "./openai-reasoner";
import type { Reasoner } from "./types";

export * from "./types";
export * from "./ir";
export { MockReasoner } from "./mock-reasoner";
export { OpenAIReasoner } from "./openai-reasoner";

let singleton: Reasoner | undefined;

/**
 * Reasoner selection point. Set BARRY_REASONER=openai (with OPENAI_API_KEY)
 * to use the LLM-backed reasoner; anything else — including no env vars at
 * all, which is what tests and local dev without a key get — falls back to
 * the deterministic mock. Nothing else in the codebase needs to know which
 * one is active.
 */
export function getReasoner(): Reasoner {
  if (!singleton) {
    singleton =
      process.env.BARRY_REASONER === "openai" && process.env.OPENAI_API_KEY
        ? new OpenAIReasoner()
        : new MockReasoner();
  }
  return singleton;
}
