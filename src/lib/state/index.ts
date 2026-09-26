export * from "./types";
export { MemoryConversationStore, getMemoryConversationStore } from "./memory-store";
export { SupabaseConversationStore } from "./supabase-store";

import type { ConversationStore } from "./types";
import { getMemoryConversationStore } from "./memory-store";
import { SupabaseConversationStore } from "./supabase-store";
import { isSupabaseConfigured } from "@/lib/store/supabase-client";

let singleton: ConversationStore | undefined;

/**
 * Picks the persistent (Supabase) store when configured, otherwise falls
 * back to the in-memory one — which is what keeps unit tests and local dev
 * without a Supabase project working unchanged.
 */
export function getConversationStore(): ConversationStore {
  if (singleton) return singleton;
  singleton = isSupabaseConfigured() ? new SupabaseConversationStore() : getMemoryConversationStore();
  return singleton;
}
