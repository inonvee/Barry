import { createInitialConversationState, type ConversationState } from "./types";

/**
 * Conversation state persistence. In-memory for Phase 1; the interface
 * shape (get/save/list by business) is what a Supabase-backed table-per-row
 * implementation would expose too.
 */
class ConversationStore {
  private conversations = new Map<string, ConversationState>();

  get(id: string): ConversationState | undefined {
    return this.conversations.get(id);
  }

  getOrCreate(id: string, businessId: string, customerId: string): ConversationState {
    const existing = this.conversations.get(id);
    if (existing) return existing;
    const fresh = createInitialConversationState(id, businessId, customerId);
    this.conversations.set(id, fresh);
    return fresh;
  }

  save(state: ConversationState): void {
    state.updatedAt = new Date().toISOString();
    this.conversations.set(state.id, state);
  }

  listByBusiness(businessId: string): ConversationState[] {
    return [...this.conversations.values()].filter((c) => c.businessId === businessId);
  }

  reset(id: string): void {
    this.conversations.delete(id);
  }
}

let singleton: ConversationStore | undefined;

export function getConversationStore(): ConversationStore {
  if (!singleton) singleton = new ConversationStore();
  return singleton;
}
