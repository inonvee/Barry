import type { DiscountAuthorityTrace, PolicyDecision } from "@/lib/policy";
import type { SchedulingConstraint } from "@/lib/scheduling/resolver";
import type { CompileDebugInfo } from "@/lib/reasoner/ir";
import type { CustomerFacingLocalDisplay } from "@/lib/reasoner/types";
import type { IRVerification } from "@/lib/reasoner/verify";
import type { NormalizedOutboundMessage } from "@/lib/channels/types";

export type ConversationStage =
  | "discovery"
  | "offer_selection"
  | "info_gathering"
  | "scheduling"
  | "payment"
  | "confirmation"
  | "escalated"
  | "closed";

export type ConversationMessage = {
  /** owner = a person on the business's side (the owner/team), sending through BARRY's channel — never BARRY. */
  role: "customer" | "barry" | "system" | "owner";
  /** Who sent an owner message (never set for BARRY's own messages). */
  author?: string;
  /** Plain text only — never markdown/image syntax. Rich content travels in `rich`. */
  content: string;
  at: string;
  /** Channel-neutral rich content (product cards, payment link) rendered by the channel. */
  rich?: NormalizedOutboundMessage["rich"];
};

/** One action BARRY took this turn — who triggered it, which capability/provider served it, what policy said, what happened. */
export type TurnStep = {
  /** "customer": the customer's message asked for it. "continuation": BARRY's goal planner took the next safe step. */
  trigger: "customer" | "continuation" | "approval";
  action: string;
  capabilities: { capability: string; provider: string | null }[];
  policy: { status: string; reason: string; policyId?: string; authority?: DiscountAuthorityTrace };
  result: { ok: boolean; error?: string } | null;
  stageBefore: string;
  stageAfter: string;
  /** Names of state keys this step changed — never their values. */
  stateKeysChanged: string[];
  /** For a step needing owner approval: a new request was sent, or the same request already existed. */
  ownerRequest?: "requested" | "still_pending" | "declined_earlier";
  /** For the generic capability action: what was planned and what happened (field names, never values). */
  generic?: {
    capability: string;
    purpose: string;
    inputFields: string[];
    authority: { status: string; reason: string; ruleId?: string };
    executed: boolean;
    verified: boolean;
    code?: string;
    system?: string;
    connector?: string;
    contractVersion?: string;
    simulated?: boolean;
  };
};

/**
 * Everything needed to answer "why did BARRY do this?" later, from the
 * database alone: which runtime/constitution/model ran, what grounding
 * rejected, each step with its capability, provider, policy decision and
 * result, and why the turn stopped.
 */
/** A classified, sanitized model-call failure (kind, provider status/code, message). */
export type ModelCallFailureTrace = { kind: string; status?: number; code?: string; message?: string; transient: boolean };

export type TurnTrace = {
  runtime: {
    barryVersion: string;
    commit: string | null;
    constitutionVersion: string;
    reasoner: "mock" | "llm";
    model: string | null;
    composerModel?: string | null;
    /** Reasoning effort actually sent (null: not a reasoning model, or provider default). */
    reasoningEffort?: string | null;
    composerReasoningEffort?: string | null;
    configError?: string;
  };
  rejectedClaims: { claim: string; reason: string }[];
  steps: TurnStep[];
  stop: { reason: string; outcome: string };
  /**
   * How understanding went this turn: whether the model's understanding was usable, the classified
   * reason when it wasn't (provider status/code, sanitized message), what was salvaged, attempts.
   * A failed understanding is never presented as an ordinary turn.
   */
  understanding?: {
    valid: boolean;
    attempts: number;
    latencyMs: number;
    failure?: ModelCallFailureTrace;
    salvagedFields?: string[];
    failClosed?: boolean;
  };
  /** Reply language and why; `fallback` when the model's reply broke a contract and the deterministic reply was used. */
  reply?: { language: string; basis: string; fallback?: string; composerFailures?: ModelCallFailureTrace[] };
  /** Asks from this message that were never carried out (told to the customer as not done). */
  notDone?: string[];
  /** ASK COMPLETENESS: each customer ask of this turn and what became of it (answered / completed / awaiting approval / …). */
  asks?: { ask: string; kind: string; status: string; topic?: string }[];
  /** Earlier not-understood customer messages re-interpreted at the start of this turn (and how many remain). */
  revalidation?: { revalidated: number; stillUnresolved: number; changedRequests: number };
  /** An owner approval that was NOT executed because the customer's intent after it is unverified. */
  hold?: { requestId: string; reason: string };
  /** Domain effects recorded THIS turn in the conversation's immutable ledger (effect type, status, frozen terms, reference). */
  effects?: { seq: number; operation: string; effect: string; status: string; terms: Record<string, string | number>; reference?: string; requestId?: string }[];
  /** The customer fields still missing after this turn (the compiler's truth). */
  missingFields?: string[];
  /**
   * What BARRY showed / held when it understood this turn, re-read from the
   * provider: the numbered products a reference resolves against, and the
   * cart. Catalog data only — never customer details.
   */
  context?: {
    shown: { position: number; title: string }[];
    cart?: { lines: { position: number; title: string; options: Record<string, string>; quantity: number }[]; total: string | null; revision?: number };
  };
};

/** One full Observe→Update runtime turn, kept for explainability/debugging. */
export type TurnLog = {
  id: string;
  at: string;
  customerMessage: string;
  understood: {
    intent: string;
    entities: Record<string, unknown>;
    /** THE single authoritative customer-info key/value bag the Reasoner proposed THIS turn (post-verifyIR, pre-sentinel-filtering) — see `compiled.appliedCustomerInfo` for what actually got merged into persistent state. */
    customerInfo?: Record<string, string>;
    /** The SEMANTIC scheduling constraint the Reasoner described ("Sunday", "at 2pm") — never a resolved timestamp. */
    schedulingWindow?: SchedulingConstraint;
    /** The grounded commerce semantics (intent, reference, variant, query) — so a failure is diagnosable from the log alone. */
    commerce?: unknown;
    purchaseDecision?: boolean;
    /** The model's literal turn signals (as returned, before compiler handling) — for independent verification. */
    signals?: {
      advancesTransaction: boolean | null;
      withdrawsRequest: boolean | null;
      changesPendingRequest: boolean | null;
      readRequested: boolean | null;
      checkoutConsent: boolean | null;
      quantity: number | null;
    };
    customerClaims?: unknown;
    /** Every ask the model found in the message, and whether this understanding covered it. */
    asks?: { ask: string; kind: string; coveredByThisIR: boolean; topic?: string }[];
    knowledgeTopic?: string;
    /** The grounded capability proposal this turn (capability, input as grounded, purpose). */
    capabilityRequest?: { capability: string; input: Record<string, unknown>; purpose: string };
  };
  retrieved: {
    offerIds: string[];
    knowledgeIds: string[];
  };
  /** What the Reasoner (LLM or mock) originally proposed vs. what verifyIR() deterministically overrode, if anything — see `understood` above for the post-verification, trusted values. */
  verification?: IRVerification;
  /** What the deterministic Action Compiler actually resolved this turn — ground truth for debugging IR/compiler mismatches. */
  compiled?: CompileDebugInfo;
  goal?: string;
  selectedAction?: { name: string; input: unknown } | null;
  policyDecision?: PolicyDecision;
  toolResult?: { ok: boolean; output?: unknown; error?: string };
  /** Business-timezone-local display facts used to phrase `response` — never the raw UTC instants above. */
  responseFacts?: { timezone: string; offeredSlot?: CustomerFacingLocalDisplay; availableSlots?: CustomerFacingLocalDisplay[] };
  response: string;
  stateAfter: Partial<ConversationState>;
  /** Which Reasoner implementation produced this turn — surfaced in the Inspector. */
  reasoner: "mock" | "llm";
  /** HQ-grade explanation of the turn (see TurnTrace). */
  trace?: TurnTrace;
};

export type ConversationState = {
  id: string;
  businessId: string;
  customerId: string;
  stage: ConversationStage;
  detectedIntent?: string;
  selectedOfferId?: string;
  knownFields: Record<string, string>;
  missingFields: string[];
  objections: string[];
  pendingAction?: { name: string; input: unknown } | null;
  pendingApprovalId?: string | null;
  outcome?: "won" | "lost" | "pending";
  messages: ConversationMessage[];
  turns: TurnLog[];
  createdAt: string;
  updatedAt: string;
  /**
   * Optimistic-concurrency version: the version this copy was read at. save() succeeds only if the stored
   * conversation is still at this version (then bumps it), so a copy read before someone else's write can
   * never overwrite that write. Absent on a copy that was never read from a store.
   */
  version?: number;
};

/**
 * Persistence interface for conversation state. `memory-store.ts` and
 * `supabase-store.ts` both implement this; the runtime only ever depends
 * on this interface via `getConversationStore()`.
 */
/** A conversation without its messages or turns — for listings (HQ). */
export type ConversationSummary = {
  id: string;
  customerId: string;
  stage: ConversationState["stage"];
  outcome: ConversationState["outcome"];
  pendingApprovalId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One turn's value-free explanation (its trace), for cross-conversation views. */
export type TurnActivity = {
  conversationId: string;
  turnId: string;
  at: string;
  reasoner: "mock" | "llm";
  intent: string | null;
  trace: TurnTrace | null;
};

/**
 * A conversation belongs to exactly one business. Asking for it under any other business is refused —
 * never answered with the other business's data, and never continued under the wrong business graph.
 */
/**
 * The conversation changed since this copy was read (another request saved first). Nothing was written:
 * the caller must re-read and redo its work, or fail closed — never overwrite.
 */
export class ConversationConflictError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation ${conversationId} changed while this request was working on it; nothing was saved`);
    this.name = "ConversationConflictError";
  }
}

export class ConversationScopeError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation ${conversationId} not found for this business`);
    this.name = "ConversationScopeError";
  }
}

/** The conversation only when it belongs to `businessId`; a foreign id reads as not found. */
export async function getConversationForBusiness(store: Pick<ConversationStore, "get">, id: string, businessId: string): Promise<ConversationState | undefined> {
  const state = await store.get(id);
  return state && state.businessId === businessId ? state : undefined;
}

export interface ConversationStore {
  get(id: string): Promise<ConversationState | undefined>;
  /** Throws ConversationScopeError when `id` already exists under a different business. */
  getOrCreate(id: string, businessId: string, customerId: string): Promise<ConversationState>;
  /** Compare-and-swap on `state.version`: throws ConversationConflictError (and writes nothing) if it moved. */
  save(state: ConversationState): Promise<void>;
  /** Fails closed (ConcurrencyGuardMissingError) when the store can't keep an owner's message as theirs (migration 0020). */
  assertOwnerMessages?(): Promise<void>;
  listByBusiness(businessId: string): Promise<ConversationState[]>;
  /** The business's conversations, most recently active first, WITHOUT messages/turns; `total` counts all of them. */
  listSummariesByBusiness(businessId: string, limit: number): Promise<{ total: number; conversations: ConversationSummary[] }>;
  /** The business's most recent turns across conversations: trace + intent only — never messages or customer details. */
  listRecentTurnActivity(businessId: string, limit: number): Promise<TurnActivity[]>;
  /** QA ONLY: delete this business's conversations whose id starts with `prefix` (messages and turns with them). */
  deleteConversationsByPrefix(businessId: string, prefix: string): Promise<number>;
}

export function createInitialConversationState(
  id: string,
  businessId: string,
  customerId: string
): ConversationState {
  const now = new Date().toISOString();
  return {
    id,
    businessId,
    customerId,
    stage: "discovery",
    knownFields: {},
    missingFields: [],
    objections: [],
    pendingAction: null,
    pendingApprovalId: null,
    outcome: "pending",
    messages: [],
    turns: [],
    createdAt: now,
    updatedAt: now,
  };
}
