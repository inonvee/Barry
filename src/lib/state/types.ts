import type { PolicyDecision } from "@/lib/policy";
import type { SchedulingConstraint, LocalDisplay } from "@/lib/scheduling/resolver";
import type { CompileDebugInfo } from "@/lib/reasoner/ir";

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
  content: string;
  at: string;
};

/** One full Observe→Update runtime turn, kept for explainability/debugging. */
export type TurnLog = {
  id: string;
  at: string;
  customerMessage: string;
  understood: {
    intent: string;
    entities: Record<string, unknown>;
    /** Raw customer-info key/value pairs the Reasoner proposed THIS turn, before sentinel-filtering — see `compiled.appliedKnownFieldsUpdate` for what actually got merged. */
    knownFieldsUpdate?: Record<string, string>;
    /** The SEMANTIC scheduling constraint the Reasoner described ("Sunday", "at 2pm") — never a resolved timestamp. */
    schedulingWindow?: SchedulingConstraint;
  };
  retrieved: {
    offerIds: string[];
    knowledgeIds: string[];
  };
  /** What the deterministic Action Compiler actually resolved this turn — ground truth for debugging IR/compiler mismatches. */
  compiled?: CompileDebugInfo;
  goal?: string;
  selectedAction?: { name: string; input: unknown } | null;
  policyDecision?: PolicyDecision;
  toolResult?: { ok: boolean; output?: unknown; error?: string };
  /** Business-timezone-local display facts used to phrase `response` — never the raw UTC instants above. */
  responseFacts?: { timezone: string; offeredSlot?: LocalDisplay; availableSlots?: LocalDisplay[] };
  response: string;
  stateAfter: Partial<ConversationState>;
  /** Which Reasoner implementation produced this turn — surfaced in the Inspector. */
  reasoner: "mock" | "llm";
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
