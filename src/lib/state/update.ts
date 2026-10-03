import { getConversationStore } from "./index";
import { ConversationConflictError, type ConversationState } from "./types";
import { withConversationLock } from "./lock";

/**
 * A small read-modify-write on ONE conversation, done safely: under the conversation's lock, on the
 * LATEST copy (re-read inside the lock), saved with the version check. A conflict (only possible if a
 * writer bypassed the lock or a lease lapsed) re-reads and re-applies `mutate` — so `mutate` must be a
 * pure function of the state it is given (an append, a status change), never a captured stale copy.
 * Returns undefined when the conversation doesn't exist (nothing written).
 */
export async function updateConversation<T>(conversationId: string, mutate: (state: ConversationState) => T | Promise<T>, opts: { waitMs?: number } = {}): Promise<{ state: ConversationState; result: T } | undefined> {
  return withConversationLock(
    conversationId,
    async () => {
      const store = getConversationStore();
      for (let attempt = 1; ; attempt++) {
        const state = await store.get(conversationId);
        if (!state) return undefined;
        const result = await mutate(state);
        try {
          await store.save(state);
          return { state, result };
        } catch (err) {
          if (!(err instanceof ConversationConflictError) || attempt >= 3) throw err;
        }
      }
    },
    opts
  );
}
