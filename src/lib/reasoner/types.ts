import type { BusinessGraph } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";
import type { BarryIR, CompileOutcome } from "./ir";

export type { BarryIR, BarryIRConstraints, RequestedCapability, CompileOutcome, CompiledToolCall, OfferFact } from "./ir";

/**
 * What BARRY has actually shown/holds for this conversation, fetched from
 * the real providers before understanding. The model resolves "the first
 * one" against THIS list; BARRY resolves the index back to real ids.
 */
export type GroundedContext = {
  shownResults?: { index: number; title: string; options: { options: Record<string, string>; price: string; inStock: boolean }[] }[];
  cart?: { index: number; title: string; options: Record<string, string>; quantity: number }[];
  cartTotal?: string;
};

export type ReasonerContext = {
  graph: BusinessGraph;
  state: ConversationState;
  customerMessage: string;
  grounded?: GroundedContext;
};

/**
 * Deterministically-computed, business-timezone-local display facts for
 * any scheduling instant a composeResponse call might need to phrase this
 * turn. This is the ONLY source of truth for "what time is that for the
 * customer" — a Reasoner (LLM or deterministic) may phrase these facts,
 * but must never reinterpret a raw ISO timestamp itself (that silently
 * defaults to the server's runtime timezone, not the business's).
 */
export type CustomerFacingLocalDisplay = {
  localDate: string;
  /** The only customer-facing time representation compose may use for this reply. */
  localTime: string;
  timeZone: string;
};

export type SchedulingDisplayFacts = {
  offeredSlot?: CustomerFacingLocalDisplay;
  availableSlots?: CustomerFacingLocalDisplay[];
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
  scheduling?: SchedulingDisplayFacts;
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
