import { createInitialConversationState, type ConversationState, type ConversationStore } from "./types";

/**
 * In-memory implementation of ConversationStore. Process-scoped — good for
 * unit tests and local dev, not durable across serverless cold starts.
 * See supabase-store.ts for the persistent implementation.
 */
export class MemoryConversationStore implements ConversationStore {
  private conversations = new Map<string, ConversationState>();

  async get(id: string): Promise<ConversationState | undefined> {
    return this.conversations.get(id);
  }

  async getOrCreate(id: string, businessId: string, customerId: string): Promise<ConversationState> {
    const existing = this.conversations.get(id);
    if (existing) return existing;
    const fresh = createInitialConversationState(id, businessId, customerId);
    this.conversations.set(id, fresh);
    return fresh;
  }

  async save(state: ConversationState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    this.conversations.set(state.id, state);
  }

  async listByBusiness(businessId: string): Promise<ConversationState[]> {
    return [...this.conversations.values()].filter((c) => c.businessId === businessId);
  }

  reset(id: string): void {
    this.conversations.delete(id);
  }
}

let singleton: MemoryConversationStore | undefined;

export function getMemoryConversationStore(): MemoryConversationStore {
  if (!singleton) singleton = new MemoryConversationStore();
  return singleton;
}
