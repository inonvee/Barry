import { MockReasoner } from "./mock-reasoner";
import type { Reasoner } from "./types";

export * from "./types";
export { MockReasoner, SCRATCH_KEYS } from "./mock-reasoner";

let singleton: Reasoner | undefined;

/**
 * Reasoner selection point. Phase 1 always uses the deterministic mock so
 * the simulator and tests run without an OpenAI key. A real OpenAI-backed
 * Reasoner can be dropped in here later behind the same interface.
 */
export function getReasoner(): Reasoner {
  if (!singleton) singleton = new MockReasoner();
  return singleton;
}
