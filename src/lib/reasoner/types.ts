import type { BusinessGraph } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";
import type { BarryIR, CompileOutcome } from "./ir";

export type { BarryIR, BarryIRConstraints, RequestedCapability, CompileOutcome, CompiledToolCall } from "./ir";

export type ReasonerContext = {
  graph: BusinessGraph;
  state: ConversationState;
  customerMessage: string;
};

/**
 * Everything a Reasoner needs to phrase the customer-facing reply for a
 * turn. `outcome` is what the deterministic Action Compiler decided (see
 * `src/lib/runtime/compiler.ts`) — a Reasoner never decides WHAT happened
 * or WHAT to ask, only HOW to say it. `toolResult` is only present when
 * `outcome.kind === "action"` and the Policy Engine allowed it to run.
 */
export type ComposeResponseInput = {
  outcome: CompileOutcome;
  toolResult?: { ok: boolean; output?: unknown; error?: string } | null;
  policyReason?: string;
};

/**
 * Provider-agnostic reasoning interface. The runtime never talks to OpenAI
 * (or any provider) directly — it only depends on this. A Reasoner
 * UNDERSTANDS free text into BARRY IR; it never constructs a tool call or
 * touches the Policy Engine. Swap providers by changing what
 * `getReasoner()` returns.
 */
export interface Reasoner {
  /** Surfaced in the simulator Inspector and persisted on every TurnLog. */
  readonly name: "mock" | "llm";
  understand(ctx: ReasonerContext): Promise<BarryIR>;
  composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string>;
}
