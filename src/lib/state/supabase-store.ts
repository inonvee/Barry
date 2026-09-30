import { getSupabaseClient } from "@/lib/store/supabase-client";
import { ConversationScopeError, createInitialConversationState } from "./types";
import type { ConversationMessage, ConversationState, ConversationStore, ConversationSummary, TurnActivity, TurnLog } from "./types";

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
      ...(m.rich ? { rich: m.rich } : {}),
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
      ...(t.trace ? { trace: t.trace } : {}),
      ...(t.verification ? { verification: t.verification } : {}),
      ...(t.compiled ? { compiled: t.compiled } : {}),
    }));

    const state = rowToState(convoRow, messages, turns);
    persistedCounts.set(state, { messages: messages.length, turns: turns.length });
    return state;
  }

  async getOrCreate(id: string, businessId: string, customerId: string): Promise<ConversationState> {
    const existing = await this.get(id);
    if (existing && existing.businessId !== businessId) throw new ConversationScopeError(id);
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
          // Channel-neutral rich payload (migration 0010); omitted when absent.
          ...(m.rich ? { rich: m.rich } : {}),
        }))
      );
      if (error) throw new Error(`Failed to save messages for ${state.id}: ${error.message}`);
    }

    const newTurns = state.turns.slice(prev.turns);
    if (newTurns.length > 0) {
      const base = newTurns.map((t) => ({
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
      }));
      // Explainability columns (migration 0011). Until 0011 is applied, the
      // turn is still saved — only the explanation is dropped, loudly.
      const explained = base.map((row, i) => ({
        ...row,
        trace: newTurns[i].trace ?? null,
        verification: newTurns[i].verification ?? null,
        compiled: newTurns[i].compiled ?? null,
      }));
      let { error } = await client.from("turn_logs").insert(explained);
      if (error && isMissingColumnError(error)) {
        console.error("[barry:store] turn_logs explainability columns missing — apply migration 0011", error.message);
        ({ error } = await client.from("turn_logs").insert(base));
      }
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

  async listSummariesByBusiness(businessId: string, limit: number): Promise<{ total: number; conversations: ConversationSummary[] }> {
    const client = getSupabaseClient();
    const { data, error, count } = await client
      .from("conversations")
      .select("id, customer_id, stage, outcome, pending_approval_id, created_at, updated_at", { count: "exact" })
      .eq("business_id", businessId)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Failed to list conversations for ${businessId}: ${error.message}`);
    return {
      total: count ?? (data ?? []).length,
      conversations: (data ?? []).map((row) => ({
        id: row.id as string,
        customerId: row.customer_id as string,
        stage: row.stage as ConversationState["stage"],
        outcome: ((row.outcome as ConversationState["outcome"]) ?? "pending"),
        pendingApprovalId: (row.pending_approval_id as string) ?? null,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
      })),
    };
  }

  async listRecentTurnActivity(businessId: string, limit: number): Promise<TurnActivity[]> {
    const client = getSupabaseClient();
    // turn_logs has no business_id: scope through this business's own conversations.
    const { data: convos, error: convoError } = await client
      .from("conversations")
      .select("id")
      .eq("business_id", businessId)
      .order("updated_at", { ascending: false })
      .limit(200);
    if (convoError) throw new Error(`Failed to list conversations for ${businessId}: ${convoError.message}`);
    const ids = (convos ?? []).map((c) => c.id as string);
    if (ids.length === 0) return [];
    const { data, error } = await client
      .from("turn_logs")
      .select("id, conversation_id, at, reasoner, trace, intent:understood->>intent")
      .in("conversation_id", ids)
      .order("at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Failed to list turn activity for ${businessId}: ${error.message}`);
    return (data ?? []).map((t) => {
      const row = t as Record<string, unknown>;
      return {
        conversationId: row.conversation_id as string,
        turnId: row.id as string,
        at: row.at as string,
        reasoner: row.reasoner as TurnActivity["reasoner"],
        intent: (row.intent as string) ?? null,
        trace: (row.trace as TurnActivity["trace"]) ?? null,
      };
    });
  }
}

/** PostgREST's "column not in schema cache" (the migration adding it isn't applied yet). */
function isMissingColumnError(error: { code?: string; message?: string }): boolean {
  return error.code === "PGRST204" || /column .* (does not exist|not find)|Could not find the '.*' column/i.test(error.message ?? "");
}
