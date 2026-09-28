import type { PolicyDecision } from "@/lib/policy";
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
  role: "customer" | "barry" | "system";
  /** Plain text only — never markdown/image syntax. Rich content travels in `rich`. */
  content: string;
  at: string;
  /** Channel-neutral rich content (product cards, payment link) rendered by the channel. */
  rich?: NormalizedOutboundMessage["rich"];
};

/** One action BARRY took this turn — who triggered it, which capability/provider served it, what policy said, what happened. */
export type TurnStep = {
  /** "customer": the customer's message asked for it. "continuation": BARRY's goal planner took the next safe step. */
  trigger: "customer" | "continuation";
  action: string;
  capabilities: { capability: string; provider: string | null }[];
  policy: { status: string; reason: string; policyId?: string };
  result: { ok: boolean; error?: string } | null;
  stageBefore: string;
  stageAfter: string;
  /** Names of state keys this step changed — never their values. */
  stateKeysChanged: string[];
};

/**
 * Everything needed to answer "why did BARRY do this?" later, from the
 * database alone: which runtime/constitution/model ran, what grounding
 * rejected, each step with its capability, provider, policy decision and
 * result, and why the turn stopped.
 */
export type TurnTrace = {
  runtime: { barryVersion: string; commit: string | null; constitutionVersion: string; reasoner: "mock" | "llm"; model: string | null };
  rejectedClaims: { claim: string; reason: string }[];
  steps: TurnStep[];
  stop: { reason: string; outcome: string };
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
};

/**
 * Persistence interface for conversation state. `memory-store.ts` and
 * `supabase-store.ts` both implement this; the runtime only ever depends
 * on this interface via `getConversationStore()`.
 */
export interface ConversationStore {
  get(id: string): Promise<ConversationState | undefined>;
  getOrCreate(id: string, businessId: string, customerId: string): Promise<ConversationState>;
  save(state: ConversationState): Promise<void>;
  listByBusiness(businessId: string): Promise<ConversationState[]>;
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
