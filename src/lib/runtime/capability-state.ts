import type { ConversationState } from "@/lib/state";
import type { CapabilityResultSummary } from "@/lib/reasoner/types";
import type { CapabilityCallResult } from "@/lib/tools/capability-tool";
import { SCRATCH_KEYS } from "./compiler";

/**
 * Results of generic capability calls, kept in conversation state so the
 * NEXT reasoning step (this turn's continuation, or the customer's next
 * message) can use them — without any per-domain code. Bounded in count and
 * size; provenance travels with each result.
 */

const MAX_RESULTS = 8;
const MAX_OUTPUT_CHARS = 2000;

export function readCapabilityResults(state: ConversationState): CapabilityResultSummary[] {
  const raw = state.knownFields[SCRATCH_KEYS.capabilityResults];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as CapabilityResultSummary[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordCapabilityResult(state: ConversationState, result: CapabilityCallResult): void {
  let output = result.output;
  if (output && JSON.stringify(output).length > MAX_OUTPUT_CHARS) output = { truncated: true };
  const entry: CapabilityResultSummary = {
    capability: result.capability,
    ok: result.ok,
    ...(output ? { output } : {}),
    verified: result.verified,
    ...(result.code ? { code: result.code } : {}),
    at: new Date().toISOString(),
  };
  state.knownFields[SCRATCH_KEYS.capabilityResults] = JSON.stringify([...readCapabilityResults(state), entry].slice(-MAX_RESULTS));
}

/** Customer-safe wording for a generic call that didn't succeed. Internal reasons stay in the trace. */
export function capabilityFailureMessage(code: string | undefined): string {
  switch (code) {
    case "not_authorized":
      return "That isn't something I'm permitted to do on my own";
    case "unverified":
      return "The system didn't confirm it, so it may not have happened";
    case "invalid_input":
    case "idempotency_key_required":
      return "I'm missing some details to do that";
    default:
      return "That system isn't available right now";
  }
}
