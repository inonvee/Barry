import { getSupabaseClient } from "@/lib/store/supabase-client";
import { ConversationConflictError, ConversationScopeError, createInitialConversationState } from "./types";
import { ConcurrencyGuardMissingError, guardMissing, isMissingFunction } from "./lock";
import type { ConversationMessage, ConversationState, ConversationStore, ConversationSummary, TurnActivity, TurnLog } from "./types";

// Tracks, per in-memory ConversationState object, which messages (by object identity) and how many turns
// have already been persisted — so save() only inserts what's new instead
// of replaying the whole conversation on every turn. Relies on the runtime
// threading the *same* object through getOrCreate()/get() -> mutate -> save()
// within one request, which is how engine.ts uses this interface.
// Messages by identity, not by count: a message inserted in time order INSIDE the transcript (a team member's
// delayed WhatsApp echo, stamped before later messages) is new too — a count-based tail slice silently dropped it
// and re-inserted the shifted last message instead. Rows are read back ordered by `at`, so position is kept.
const persisted = new WeakMap<ConversationState, { messages: WeakSet<ConversationMessage>; turns: number }>();
const markPersisted = (state: ConversationState) => persisted.set(state, { messages: new WeakSet(state.messages), turns: state.turns.length });

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
    // Before migration 0019 the column doesn't exist: such a copy can only be saved the legacy way.
    ...(typeof row.version === "number" || typeof row.version === "string" ? { version: Number(row.version) } : {}),
  };
}

let ownerMessagesReady = false;

export class SupabaseConversationStore implements ConversationStore {
  /** Owner messages need messages.role 'owner' + messages.author (0020). Probed once per process; never assumed. */
  async assertOwnerMessages(): Promise<void> {
    if (ownerMessagesReady) return;
    const { error } = await getSupabaseClient().from("messages").select("author").limit(0);
    if (error && (error.code === "42703" || /column .*author.* does not exist|Could not find the 'author' column/i.test(error.message ?? ""))) {
      console.error("[barry:handoff] messages.author is missing — migration 0020 (human handoff) is NOT applied. Owner replies are BLOCKED until it is.");
      throw new ConcurrencyGuardMissingError("owner messages unavailable", "0020");
    }
    if (error) throw new Error(`Couldn't verify the message store: ${error.message}`);
    ownerMessagesReady = true;
  }

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
      ...(m.author ? { author: m.author } : {}),
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
    markPersisted(state);
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
    if (error) {
      // Two requests created the same new conversation at once: the first insert won — use its row.
      if (error.code === "23505") {
        const winner = await this.get(id);
        if (winner && winner.businessId !== businessId) throw new ConversationScopeError(id);
        if (winner) return winner;
      }
      throw new Error(`Failed to create conversation ${id}: ${error.message}`);
    }

    markPersisted(fresh);
    return { ...fresh, version: 0 };
  }

  /**
   * Compare-and-swap save in ONE database transaction (migration 0019): the row is written only if it is
   * still at the version this copy was read at, together with the new messages and turns — all or nothing.
   * A conflict writes nothing and throws ConversationConflictError. Without migration 0019 (no function, or
   * a row read without a version) it FAILS CLOSED — there is no unprotected save path.
   */
  async save(state: ConversationState): Promise<void> {
    if (state.version === undefined) guardMissing("conversation read without a version column");
    const prev = persisted.get(state);
    const updatedAt = new Date().toISOString();
    const row = { stage: state.stage, detected_intent: state.detectedIntent ?? null, selected_offer_id: state.selectedOfferId ?? null, known_fields: state.knownFields, missing_fields: state.missingFields, objections: state.objections, pending_action: state.pendingAction ?? null, pending_approval_id: state.pendingApprovalId ?? null, outcome: state.outcome ?? null, updated_at: updatedAt };
    const messages = state.messages.filter((m) => !prev?.messages.has(m)).map((m) => ({ role: m.role, content: m.content, at: m.at, ...(m.rich ? { rich: m.rich } : {}), ...(m.author ? { author: m.author } : {}) }));
    const turns = state.turns.slice(prev?.turns ?? 0).map((t) => ({ id: t.id, at: t.at, customer_message: t.customerMessage, understood: t.understood, retrieved: t.retrieved, goal: t.goal ?? null, selected_action: t.selectedAction ?? null, policy_decision: t.policyDecision ?? null, tool_result: t.toolResult ?? null, response: t.response, state_after: t.stateAfter, reasoner: t.reasoner, trace: t.trace ?? null, verification: t.verification ?? null, compiled: t.compiled ?? null }));
    const { data, error } = await getSupabaseClient().rpc("barry_save_conversation", { p_id: state.id, p_expected_version: state.version, p_row: row, p_messages: messages, p_turns: turns });
    if (isMissingFunction(error)) guardMissing("atomic conversation save unavailable");
    if (error) throw new Error(`Failed to save conversation ${state.id}: ${error.message}`);
    if (data === null || data === undefined) throw new ConversationConflictError(state.id);
    state.updatedAt = updatedAt;
    state.version = Number(data);
    markPersisted(state);
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

  async deleteConversationsByPrefix(businessId: string, prefix: string): Promise<number> {
    if (!prefix) throw new Error("A prefix is required");
    const client = getSupabaseClient();
    const pattern = `${prefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    // messages and turn_logs cascade from conversations (0001).
    const { count, error } = await client.from("conversations").delete({ count: "exact" }).eq("business_id", businessId).like("id", pattern);
    if (error) throw new Error(`Failed to delete QA conversations for ${businessId}: ${error.message}`);
    return count ?? 0;
  }
}
