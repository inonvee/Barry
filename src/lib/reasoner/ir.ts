import type { Goal } from "@/lib/business-graph";
import type { ConversationStage } from "@/lib/state";

/**
 * BARRY IR v0.1 — the ONLY thing a Reasoner (mock or LLM) is allowed to
 * produce. It is understanding, not execution: no reasoner, LLM-backed or
 * not, ever constructs a tool call. That is the deterministic Action
 * Compiler's job (`src/lib/runtime/compiler.ts`) — it assembles a
 * `ToolCall` from this IR plus accumulated ConversationState plus the
 * Business Graph, and validates it against the tool's own Zod schema
 * before anything downstream (Policy Engine, `callTool`) ever sees it.
 *
 * `constraints` are the only typed signals the compiler trusts for
 * assembling tool input. `entities` is a free-form bag kept only for
 * Inspector/debugging — the compiler never reads it.
 */
export type BarryIRConstraints = {
  schedulingWindow?: { earliest: string; latest?: string };
  partySize?: number;
  discountPct?: number;
  /** Customer confirmed the previously offered slot works for them. */
  slotAccepted?: boolean;
};

/**
 * Advisory-only hint about what the customer wants next. The compiler
 * decides what BARRY actually does from Business Graph capabilities and
 * accumulated state — it is free to ignore this. Only a small recognized
 * vocabulary affects compiler behavior at all (currently: "ask_price").
 */
export type RequestedCapability = "ask_price" | string;

export type BarryIR = {
  intent: string;
  /** A single confident offer match. */
  selectedOfferId?: string;
  /** Multiple plausible offers — the compiler asks which one instead of guessing. */
  offerCandidateIds?: string[];
  entities: Record<string, unknown>;
  constraints: BarryIRConstraints;
  /** Customer-info fields (name/email/phone/...) extracted this turn. */
  knownFieldsUpdate: Record<string, string>;
  requestedCapability?: RequestedCapability;
  goal?: Goal;
};

export type CompiledToolCall = { name: string; input: Record<string, unknown> };

/**
 * What the deterministic Action Compiler (`src/lib/runtime/compiler.ts`)
 * decided BARRY should do next, given some Reasoner's IR. `action` is the
 * only variant that reaches the Policy Engine / tool registry — every
 * other variant means "ask the customer something," with the exact thing
 * to ask carried as data. A Reasoner's `composeResponse()` phrases these
 * into natural language; it never invents which one applies.
 */
export type CompileOutcome = { stage: ConversationStage } & (
  | { kind: "action"; action: CompiledToolCall; goal?: Goal }
  | { kind: "ask_general"; offerNames: string[] }
  | { kind: "clarify_offer"; offerNames: string[] }
  | { kind: "needs_info"; offerName: string; missingFields: string[] }
  | { kind: "ask_datetime"; offerName: string }
  | { kind: "ask_slot_confirm"; offeredStart: string }
  | { kind: "waiting_payment" }
  | { kind: "price_fact"; offerName: string; price: number; currency: string }
  | { kind: "generic_confirm" }
  /** Assembled input failed the tool's own schema — a compiler bug, not a customer data problem. Never reaches callTool(). */
  | { kind: "compiler_error"; reason: string }
);
