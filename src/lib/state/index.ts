export * from "./types";
export { MemoryConversationStore, getMemoryConversationStore } from "./memory-store";
export { SupabaseConversationStore } from "./supabase-store";

import type { ConversationStore } from "./types";
import { getMemoryConversationStore } from "./memory-store";
import { SupabaseConversationStore } from "./supabase-store";
import { isSupabaseConfigured } from "@/lib/store/supabase-client";
import { BarryConfigurationError, isProductionRuntime } from "@/lib/env";

let singleton: ConversationStore | undefined;

/**
 * Picks the persistent (Supabase) store when configured; in local dev /
 * tests, falls back to the in-memory one when it isn't. In a real
 * deployment (NODE_ENV=production), that fallback is disabled — BARRY
 * must never silently lose conversation state to an in-memory store
 * because Supabase wasn't configured. Misconfiguration throws loudly.
 */
export function getConversationStore(): ConversationStore {
  if (singleton) return singleton;

  if (isProductionRuntime() && !isSupabaseConfigured()) {
    throw new BarryConfigurationError(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production. " +
        "Refusing to silently run conversations on in-memory (non-persistent) state."
    );
  }

  singleton = isSupabaseConfigured() ? new SupabaseConversationStore() : getMemoryConversationStore();
  return singleton;
}
