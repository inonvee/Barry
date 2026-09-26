import { getSupabaseClient } from "@/lib/store/supabase-client";
import { createInitialConversationState } from "./types";
import type { ConversationMessage, ConversationState, ConversationStore, TurnLog } from "./types";

// Tracks, per in-memory ConversationState object, how many messages/turns
// have already been persisted — so save() only inserts what's new instead
// of replaying the whole conversation on every turn. Relies on the runtime
// threading the *same* object through getOrCreate()/get() -> mutate -> save()
// within one request, which is how engine.ts uses this interface.
const persistedCounts = new WeakMap<ConversationState, { messages: number; turns: number }>();

function rowToState(
  row: Record<string, unknown>,
  messages: ConversationMessage[],
  turns: TurnLog[]
): ConversationState {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    customerId: row.customer_id as string,
    stage: row.stage as ConversationState["stage"],
    detectedIntent: (row.detected_intent as string) ?? undefined,
    selectedOfferId: (row.selected_offer_id as string) ?? undefined,
    knownFields: (row.known_fields as Record<string, string>) ?? {},
    missingFields: (row.missing_fields as string[]) ?? [],
    objections: (row.objections as string[]) ?? [],
    pendingAction: (row.pending_action as ConversationState["pendingAction"]) ?? null,
    pendingApprovalId: (row.pending_approval_id as string) ?? null,
    outcome: (row.outcome as ConversationState["outcome"]) ?? "pending",
    messages,
    turns,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class SupabaseConversationStore implements ConversationStore {
  async get(id: string): Promise<ConversationState | undefined> {
    const client = getSupabaseClient();
    const { data: convoRow, error: convoError } = await client
      .from("conversations")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (convoError) throw new Error(`Failed to load conversation ${id}: ${convoError.message}`);
    if (!convoRow) return undefined;

    const [{ data: messageRows, error: messagesError }, { data: turnRows, error: turnsError }] =
      await Promise.all([
        client.from("messages").select("*").eq("conversation_id", id).order("at", { ascending: true }),
        client.from("turn_logs").select("*").eq("conversation_id", id).order("at", { ascending: true }),
      ]);
    if (messagesError) throw new Error(`Failed to load messages for ${id}: ${messagesError.message}`);
    if (turnsError) throw new Error(`Failed to load turn logs for ${id}: ${turnsError.message}`);

    const messages: ConversationMessage[] = (messageRows ?? []).map((m) => ({
      role: m.role,
      content: m.content,
      at: m.at,
    }));
    const turns: TurnLog[] = (turnRows ?? []).map((t) => ({
      id: t.id,
      at: t.at,
      customerMessage: t.customer_message,
      understood: t.understood,
      retrieved: t.retrieved,
      goal: t.goal ?? undefined,
      selectedAction: t.selected_action,
      policyDecision: t.policy_decision ?? undefined,
      toolResult: t.tool_result ?? undefined,
      response: t.response,
      stateAfter: t.state_after,
      reasoner: t.reasoner,
    }));

    const state = rowToState(convoRow, messages, turns);
    persistedCounts.set(state, { messages: messages.length, turns: turns.length });
    return state;
  }

  async getOrCreate(id: string, businessId: string, customerId: string): Promise<ConversationState> {
    const existing = await this.get(id);
    if (existing) return existing;

    const fresh = createInitialConversationState(id, businessId, customerId);
    const client = getSupabaseClient();
    const { error } = await client.from("conversations").insert({
      id: fresh.id,
      business_id: fresh.businessId,
      customer_id: fresh.customerId,
      stage: fresh.stage,
      known_fields: fresh.knownFields,
      missing_fields: fresh.missingFields,
      objections: fresh.objections,
      outcome: fresh.outcome,
      created_at: fresh.createdAt,
      updated_at: fresh.updatedAt,
    });
    if (error) throw new Error(`Failed to create conversation ${id}: ${error.message}`);

    persistedCounts.set(fresh, { messages: 0, turns: 0 });
    return fresh;
  }

  async save(state: ConversationState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    const client = getSupabaseClient();

    const { error: updateError } = await client
      .from("conversations")
      .update({
        stage: state.stage,
        detected_intent: state.detectedIntent ?? null,
        selected_offer_id: state.selectedOfferId ?? null,
        known_fields: state.knownFields,
        missing_fields: state.missingFields,
        objections: state.objections,
        pending_action: state.pendingAction ?? null,
        pending_approval_id: state.pendingApprovalId ?? null,
        outcome: state.outcome ?? null,
        updated_at: state.updatedAt,
      })
      .eq("id", state.id);
    if (updateError) throw new Error(`Failed to save conversation ${state.id}: ${updateError.message}`);

    const prev = persistedCounts.get(state) ?? { messages: 0, turns: 0 };

    const newMessages = state.messages.slice(prev.messages);
    if (newMessages.length > 0) {
      const { error } = await client.from("messages").insert(
        newMessages.map((m) => ({
          conversation_id: state.id,
          role: m.role,
          content: m.content,
          at: m.at,
        }))
      );
      if (error) throw new Error(`Failed to save messages for ${state.id}: ${error.message}`);
    }

    const newTurns = state.turns.slice(prev.turns);
    if (newTurns.length > 0) {
      const { error } = await client.from("turn_logs").insert(
        newTurns.map((t) => ({
          id: t.id,
          conversation_id: state.id,
          at: t.at,
          customer_message: t.customerMessage,
          understood: t.understood,
          retrieved: t.retrieved,
          goal: t.goal ?? null,
          selected_action: t.selectedAction ?? null,
          policy_decision: t.policyDecision ?? null,
          tool_result: t.toolResult ?? null,
          response: t.response,
          state_after: t.stateAfter,
          reasoner: t.reasoner,
        }))
      );
      if (error) throw new Error(`Failed to save turn logs for ${state.id}: ${error.message}`);
    }

    persistedCounts.set(state, { messages: state.messages.length, turns: state.turns.length });
  }

  async listByBusiness(businessId: string): Promise<ConversationState[]> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("conversations")
      .select("id")
      .eq("business_id", businessId);
    if (error) throw new Error(`Failed to list conversations for ${businessId}: ${error.message}`);

    const states = await Promise.all((data ?? []).map((row) => this.get(row.id as string)));
    return states.filter((s): s is ConversationState => s !== undefined);
  }
}
