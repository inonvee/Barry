import type { Goal } from "@/lib/business-graph";
import type { ConversationStage } from "@/lib/state";
import type { SchedulingConstraint } from "@/lib/scheduling/resolver";

export type { SchedulingConstraint, DateSpec, TimeSpec } from "@/lib/scheduling/resolver";

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
  /**
   * SEMANTIC scheduling info only ("Sunday", "at 2pm") — never a resolved
   * timestamp. A Reasoner (LLM or regex-based) must never compute a UTC
   * instant itself; `src/lib/scheduling/resolver.ts` is the one place
   * that turns this into an absolute instant, using the business's own
   * timezone (`business.timezone`), and only the Action Compiler calls it.
   */
  schedulingWindow?: SchedulingConstraint;
  partySize?: number;
  discountPct?: number;
  /** Customer confirmed the previously offered slot works for them. */
  slotAccepted?: boolean;
};

/**
 * Advisory-only hint about what the customer wants next. The compiler
 * decides what BARRY actually does from Business Graph capabilities and
 * accumulated state — it is free to ignore this. Only a small recognized
 * vocabulary affects compiler behavior at all (currently: "ask_price",
 * "ask_duration", "ask_deposit").
 */
export type RequestedCapability = "ask_price" | "ask_duration" | "ask_deposit" | string;

export type BarryIR = {
  intent: string;
  /** A single confident offer match. */
  selectedOfferId?: string;
  /** Multiple plausible offers — the compiler asks which one instead of guessing. */
  offerCandidateIds?: string[];
  /**
   * An EXPLICIT request to replace the already-selected offer with a
   * different one (e.g. "actually, solo instead"). Distinct from
   * `selectedOfferId`/`offerCandidateIds`, which only ever apply to the
   * *initial* selection — once an offer is chosen for a conversation, it's
   * sticky against everything except this explicit signal. This is what
   * lets a deliberate change-of-mind through without random model drift
   * silently reinterpreting an unrelated later message as a new choice.
   */
  offerChangeRequested?: string;
  /**
   * Free-form, debug-only semantic entities (Inspector display) — NEVER
   * a channel for persistent customer identity. `customerInfo` below is
   * the ONE authoritative representation of customer-provided fields
   * (name/email/phone/...); the compiler never reads `entities` at all.
   * A Reasoner must not treat these two fields as duplicates of the same
   * fact — that's exactly the live bug this split guards against: a
   * Reasoner correctly describing a fact in `entities` while omitting it
   * from `customerInfo` (the field that actually reaches persistent
   * state) must never again lose that fact.
   */
  entities: Record<string, unknown>;
  constraints: BarryIRConstraints;
  /**
   * THE single authoritative representation of customer-provided
   * identity/contact fields (name, phone, email, or any other field a
   * Business Graph's `requiredCustomerInfo` names) extracted THIS turn.
   * This is the only field the compiler merges into persistent
   * `ConversationState.knownFields` — see `normalizeCustomerFieldValue`
   * in `customer-fields.ts` for the trust boundary every value passes
   * through first.
   */
  customerInfo: Record<string, string>;
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
/**
 * A safe Business Graph fact, answerable without any transaction-required
 * customer info: `requiredCustomerInfo` means "required to FULFILL a
 * transaction," never "required before BARRY may state a fact that's
 * already sitting in the Business Graph." Never fabricated — every
 * variant here is read directly off the resolved `Offer`.
 */
export type OfferFact =
  | { type: "price"; price: number; currency: string }
  | { type: "duration"; minutes: number }
  | { type: "deposit"; required: boolean; amount?: number; currency?: string };

/**
 * Observability for the exact class of live bugs a raw IR/compile() call
 * can't otherwise prove happened after the fact: what the compiler
 * actually resolved a semantic scheduling constraint to (an absolute UTC
 * window), and what it actually merged into persistent customer-info
 * fields this turn, after sentinel-value filtering
 * (`normalizeCustomerFieldValue`). Attached to every CompileOutcome so
 * the Inspector can show ground truth instead of requiring log
 * spelunking.
 */
export type CompileDebugInfo = {
  appliedCustomerInfo: Record<string, string>;
  resolvedSchedulingWindow?: { earliest: string; latest: string; anomaly?: "nonexistent" | "ambiguous" };
};

export type CompileOutcome = { stage: ConversationStage; debug?: CompileDebugInfo } & (
  | { kind: "action"; action: CompiledToolCall; goal?: Goal }
  | { kind: "ask_general"; offerNames: string[] }
  | { kind: "clarify_offer"; offerNames: string[] }
  | { kind: "needs_info"; offerName: string; missingFields: string[] }
  | { kind: "ask_datetime"; offerName: string }
  | { kind: "ask_slot_confirm"; offeredStart: string }
  | { kind: "waiting_payment" }
  | { kind: "offer_fact"; offerName: string; fact: OfferFact }
  | { kind: "generic_confirm" }
  /** Assembled input failed the tool's own schema — a compiler bug, not a customer data problem. Never reaches callTool(). */
  | { kind: "compiler_error"; reason: string }
);
