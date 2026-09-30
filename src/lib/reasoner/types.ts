import type { ReplyLanguage } from "./language";
import type { CapabilityProfiles } from "@/lib/capabilities/model";
import type { CatalogSchema } from "@/lib/commerce/catalog";
import type { BusinessGraph } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";
import type { BarryIR, CompileOutcome } from "./ir";
import type { Quote } from "@/lib/runtime/pricing";
import type { LedgerEntry } from "@/lib/runtime/ledger";
import type { WriteBlock } from "@/lib/runtime/write-gate";

export type { BarryIR, BarryIRConstraints, RequestedCapability, CompileOutcome, CompiledToolCall, OfferFact } from "./ir";

/**
 * What BARRY has actually shown/holds for this conversation, fetched from
 * the real providers before understanding. The model resolves "the first
 * one" against THIS list; BARRY resolves the index back to real ids.
 */
export type ShownResult = {
  position: number;
  title: string;
  variants: { options: Record<string, string>; price: string; inStock: boolean }[];
};

export type GroundedContext = {
  /** The commerce provider's searchable schema (categories, attributes, variant options, currency). */
  catalog?: CatalogSchema;
  /** What the business's connected providers can actually do. */
  profiles?: CapabilityProfiles;
  /**
   * What BARRY last showed the customer, numbered exactly as they saw it
   * (position 1 = the first card). The model refers to items by position;
   * it never sees or supplies product ids.
   */
  shownResults?: ShownResult[];
  /** Internal (never given to the model): the same list with real ids, re-read from the provider. */
  shownProducts?: (ShownResult & { id: string })[];
  cart?: { position: number; title: string; options: Record<string, string>; quantity: number }[];
  /** Internal (never given to the model): the same cart lines with their real ids, re-read from the provider. */
  cartLines?: { position: number; id: string; title: string; options: Record<string, string>; quantity: number }[];
  cartTotal?: string;
  /** The business-specific capability surface the model may propose from (safe summary; no systems or credentials). */
  capabilities?: CapabilitySurfaceEntry[];
  /** Results of capabilities BARRY already ran in this conversation (most recent last). */
  capabilityResults?: CapabilityResultSummary[];
  /** Every request BARRY sent to the owner in this conversation, with its real status and outcome (customer-safe). */
  ownerRequests?: OwnerRequestView[];
  /** Multi-ask continuation: what was already carried out this turn, and the customer's asks not yet done. */
  doneThisTurn?: string[];
  remainingAsks?: string[];
  /** Asks from this message that were never carried out (runtime truth, for the reply). */
  notDone?: string[];
  /** The requests the customer's changed terms are replacing (revision continuation): propose the replacement. */
  replacingRequests?: OwnerRequestView[];
  /** This turn changed a pending request's terms and no valid replacement was created. */
  revisionWithoutReplacement?: boolean;
  /** The conversation's effect ledger (immutable domain effects) and where this turn's entries start. */
  ledger?: LedgerEntry[];
  turnStartSeq?: number;
};

export type OwnerRequestView = {
  about: string;
  status: "waiting_on_owner" | "approved" | "declined_by_owner" | "withdrawn_by_customer" | "superseded";
  /** Authoritative lifecycle: active, superseded, withdrawn, declined, executed, executed_unconfirmed, failed, approved. */
  lifecycle: string;
  /** Revision of this operation within the conversation (1 = first). */
  revision: number;
  /** The exact terms this request was made with — frozen; a later reference never rewrites them. */
  terms: Record<string, string | number>;
  /** For an approved request: what actually happened when BARRY carried it out. */
  result?: "done" | "done_unconfirmed" | "failed";
  /** The business reference produced by THIS request (e.g. the ticket number) — belongs to these terms only. */
  reference?: string;
};

export type CapabilitySurfaceEntry = {
  id: string;
  purpose: string;
  effect: "read" | "consequential";
  /** `options`: the contract's own closed set of values for an enum field. */
  inputs: { name: string; type: string; required: boolean; options?: string[] }[];
  /** An active, healthy system of this business can execute it right now. */
  available: boolean;
  /** How the business governs it: automatic, conditional (rules decide per call), owner_approval, not_permitted (no rule allows it — reads included). */
  authority: string;
};

export type CapabilityResultSummary = { capability: string; ok: boolean; output?: Record<string, unknown>; verified: boolean; code?: string; at: string };

export type ReasonerContext = {
  graph: BusinessGraph;
  state: ConversationState;
  customerMessage: string;
  grounded?: GroundedContext;
  /** Where a Reasoner records model-call failures it recovered from (e.g. a composer call that fell back), for the turn trace. */
  diagnostics?: { composerFailures: ModelCallFailure[] };
};

/**
 * Why a model call did not produce usable output — classified, and sanitized (no keys, no raw
 * payloads). This is what the Inspector shows instead of a silent generic reply.
 */
export type ModelCallFailureKind =
  | "provider_rate_limited"
  | "provider_quota_exhausted"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_connection"
  | "provider_auth"
  | "provider_rejected_request"
  | "provider_error"
  | "empty_completion"
  | "json_parse_error"
  | "schema_validation_error"
  | "invalid_model_config";

export type ModelCallFailure = {
  kind: ModelCallFailureKind;
  /** HTTP status the provider returned, when there was one. */
  status?: number;
  /** The provider's own error code / type (e.g. rate_limit_exceeded, insufficient_quota). */
  code?: string;
  /** Sanitized, truncated provider message or validation issue list. */
  message?: string;
  /** Whether a retry could plausibly succeed (rate limit, 5xx, timeout, malformed output). */
  transient: boolean;
};

/** Understanding plus what it took: whether it is usable, how it failed, what was salvaged. */
export type UnderstandingResult = {
  ir: BarryIR;
  /** The model produced a usable understanding (possibly after salvage/retry). */
  valid: boolean;
  attempts: number;
  /** The last failure (on a valid result: the failure a retry recovered from). */
  failure?: ModelCallFailure;
  /** Fields that were malformed and dropped instead of discarding the whole understanding. */
  salvagedFields?: string[];
  /** A dropped field could have carried a transaction decision: this turn may not advance or write. */
  failClosed?: boolean;
  latencyMs: number;
  usage: { promptTokens: number; completionTokens: number; reasoningTokens: number };
  model: string;
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
export type ComposeStep = {
  outcome: CompileOutcome;
  toolResult?: { ok: boolean; output?: unknown; error?: string } | null;
  /** Owner approval was requested for this step (internal rule text; never quoted). */
  policyReason?: string;
  /** The business's rules don't allow this step. */
  refused?: boolean;
  /** Approval was needed and the same request already existed. */
  existingOwnerRequest?: "still_pending" | "declined_earlier";
};

export type ComposeResponseInput = {
  outcome: CompileOutcome;
  toolResult?: { ok: boolean; output?: unknown; error?: string } | null;
  /**
   * Set when BARRY asked the owner to approve this action. INTERNAL: the
   * business's own rule text — composers only say an owner approval was
   * requested and never quote it to the customer.
   */
  policyReason?: string;
  /** The business's rules don't let BARRY do this at all (never quoted either). */
  refused?: boolean;
  /** This reply follows the owner's decision on an approval BARRY asked for earlier. */
  ownerDecision?: "approved" | "declined";
  /**
   * The same request (same operation and terms) already exists: still waiting on the owner (nothing
   * new was sent), or declined by the owner earlier (not re-sent on the same terms).
   */
  existingOwnerRequest?: "still_pending" | "declined_earlier";
  /** Requests sent to the owner in this conversation (customer-safe) — lets a plain reply state their real status. */
  ownerRequests?: OwnerRequestView[];
  /** The authoritative quantity-aware quote for what's being discussed (the only source of totals). */
  quote?: Quote;
  /** A deterministic, localized statement of where things really stand (requests, booking, payment, quote). */
  statusText?: string;
  /** The final-write gate stopped the payment/checkout this turn: why, with the real numbers. */
  writeBlocked?: WriteBlock;
  /** The customer changed a pending request's terms but no valid replacement was created: the old one is gone. */
  revisionWithoutReplacement?: boolean;
  /** A draft that failed grounding: regenerate the WHOLE reply from trusted facts, dropping dependent conclusions. */
  repair?: { draft: string; problems: string[] };
  scheduling?: SchedulingDisplayFacts;
  /** When BARRY took several steps this turn: all of them, in order (the last equals outcome/toolResult). */
  steps?: ComposeStep[];
  /** The one thing still needed from the customer after those steps, if any. */
  next?: CompileOutcome;
  /** Things the customer asked for in this message that were NOT done (their words) — say so; never imply them. */
  notDone?: string[];
  /** The conversation's reply language (resolved by the runtime; never from a digits-only message). */
  language?: ReplyLanguage;
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
  /** understand() with its outcome: validity, classified failure, salvage. The runtime prefers this. */
  understandDetailed?(ctx: ReasonerContext): Promise<UnderstandingResult>;
  composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string>;
  /** The underlying understanding model id, when there is one (recorded in turn traces). */
  readonly model?: string;
  /** The model that words replies, when different. */
  readonly composerModel?: string;
  /** Reasoning effort actually sent with understanding / composition calls (reasoning models only). */
  readonly reasoningEffort?: string;
  readonly composerReasoningEffort?: string;
  /** A model configuration error (e.g. an invalid effort). Understanding then fails closed; replies are deterministic. */
  readonly configError?: string;
}
