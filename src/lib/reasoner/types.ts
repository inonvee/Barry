import type { BusinessGraph, Goal } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";

export type ReasonerContext = {
  graph: BusinessGraph;
  state: ConversationState;
  customerMessage: string;
};

export type PlannedAction = {
  name: string;
  input: Record<string, unknown>;
} | null;

export type PlanResult = {
  intent: string;
  entities: Record<string, unknown>;
  goal?: Goal;
  stage: ConversationState["stage"];
  selectedOfferId?: string;
  knownFieldsUpdate: Record<string, string>;
  missingFields: string[];
  retrievedOfferIds: string[];
  retrievedKnowledgeIds: string[];
  action: PlannedAction;
  /** Response to use directly when no action is planned. */
  directResponse?: string;
};

export type ComposeResponseInput = {
  plan: PlanResult;
  toolResult: { ok: boolean; output?: unknown; error?: string } | null;
  policyReason?: string;
};

/**
 * Provider-agnostic reasoning interface. The runtime never talks to OpenAI
 * (or any provider) directly — it only depends on this. Swap providers by
 * changing what `getReasoner()` returns.
 */
export interface Reasoner {
  plan(ctx: ReasonerContext): Promise<PlanResult>;
  composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string>;
}
