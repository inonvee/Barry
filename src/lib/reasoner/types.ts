import type { ReplyLanguage } from "./language";
import type { CapabilityProfiles } from "@/lib/capabilities/model";
import type { CatalogSchema } from "@/lib/commerce/catalog";
import type { BusinessGraph } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";
import type { BarryIR, CompileOutcome } from "./ir";

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
  cartTotal?: string;
  /** The business-specific capability surface the model may propose from (safe summary; no systems or credentials). */
  capabilities?: CapabilitySurfaceEntry[];
  /** Results of capabilities BARRY already ran in this conversation (most recent last). */
  capabilityResults?: CapabilityResultSummary[];
  /** Every request BARRY sent to the owner in this conversation, with its real status and outcome (customer-safe). */
  ownerRequests?: OwnerRequestView[];
};

export type OwnerRequestView = {
  about: string;
  status: "waiting_on_owner" | "approved" | "declined_by_owner" | "withdrawn_by_customer";
  /** For an approved request: what actually happened when BARRY carried it out. */
  result?: "done" | "done_unconfirmed" | "failed";
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
  scheduling?: SchedulingDisplayFacts;
  /** When BARRY took several steps this turn: all of them, in order (the last equals outcome/toolResult). */
  steps?: ComposeStep[];
  /** The one thing still needed from the customer after those steps, if any. */
  next?: CompileOutcome;
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
