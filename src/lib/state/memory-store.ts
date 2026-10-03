import { ConversationConflictError, ConversationScopeError, createInitialConversationState, type ConversationState, type ConversationStore, type ConversationSummary, type TurnActivity } from "./types";

/**
 * In-memory implementation of ConversationStore. Process-scoped — good for
 * unit tests and local dev, not durable across serverless cold starts.
 * See supabase-store.ts for the persistent implementation.
 *
 * It behaves like the real store on purpose: every read returns an independent COPY (two requests never
 * share an object), and save() is compare-and-swap on `version` — so races that would lose data in
 * production fail the same way here.
 */
export class MemoryConversationStore implements ConversationStore {
  private conversations = new Map<string, ConversationState>();

  async get(id: string): Promise<ConversationState | undefined> {
    const c = this.conversations.get(id);
    return c ? structuredClone(c) : undefined;
  }

  async getOrCreate(id: string, businessId: string, customerId: string): Promise<ConversationState> {
    const existing = this.conversations.get(id);
    if (existing && existing.businessId !== businessId) throw new ConversationScopeError(id);
    if (existing) return structuredClone(existing);
    const fresh = { ...createInitialConversationState(id, businessId, customerId), version: 0 };
    this.conversations.set(id, structuredClone(fresh));
    return fresh;
  }

  async save(state: ConversationState): Promise<void> {
    const stored = this.conversations.get(state.id);
    const expected = state.version ?? 0;
    if (stored && (stored.version ?? 0) !== expected) throw new ConversationConflictError(state.id);
    state.updatedAt = new Date().toISOString();
    state.version = expected + 1;
    this.conversations.set(state.id, structuredClone(state));
  }

  async listByBusiness(businessId: string): Promise<ConversationState[]> {
    return [...this.conversations.values()].filter((c) => c.businessId === businessId).map((c) => structuredClone(c));
  }

  async listSummariesByBusiness(businessId: string, limit: number): Promise<{ total: number; conversations: ConversationSummary[] }> {
    const all = (await this.listByBusiness(businessId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      total: all.length,
      conversations: all.slice(0, limit).map((c) => ({
        id: c.id,
        customerId: c.customerId,
        stage: c.stage,
        outcome: c.outcome,
        pendingApprovalId: c.pendingApprovalId ?? null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    };
  }

  async listRecentTurnActivity(businessId: string, limit: number): Promise<TurnActivity[]> {
    return (await this.listByBusiness(businessId))
      .flatMap((c) => c.turns.map((t) => ({ conversationId: c.id, turnId: t.id, at: t.at, reasoner: t.reasoner, intent: t.understood.intent ?? null, trace: t.trace ?? null })))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  }

  async deleteConversationsByPrefix(businessId: string, prefix: string): Promise<number> {
    if (!prefix) throw new Error("A prefix is required");
    let n = 0;
    for (const [id, c] of this.conversations) {
      if (c.businessId !== businessId || !id.startsWith(prefix)) continue;
      this.conversations.delete(id);
      n++;
    }
    return n;
  }

  reset(id: string): void {
    this.conversations.delete(id);
  }
}

// Kept on globalThis: in `next dev`, route handlers and pages are separate
// module graphs, and must still see the same process-local data.
const holder = globalThis as { __barryMemoryConversationStore?: MemoryConversationStore };

export function getMemoryConversationStore(): MemoryConversationStore {
  if (!holder.__barryMemoryConversationStore) holder.__barryMemoryConversationStore = new MemoryConversationStore();
  return holder.__barryMemoryConversationStore;
}
