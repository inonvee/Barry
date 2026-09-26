import type { PolicyDecision } from "@/lib/policy";

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
  };
  retrieved: {
    offerIds: string[];
    knowledgeIds: string[];
  };
  goal?: string;
  selectedAction?: { name: string; input: unknown } | null;
  policyDecision?: PolicyDecision;
  toolResult?: { ok: boolean; output?: unknown; error?: string };
  response: string;
  stateAfter: Partial<ConversationState>;
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
