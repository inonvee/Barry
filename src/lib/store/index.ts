export * from "./types";
export { MemoryBackend, getBackend as getMemoryBackend } from "./memory-backend";
export { SupabaseBackend } from "./supabase-backend";
export { isSupabaseConfigured } from "./supabase-client";

import type { BarryBackend } from "./types";
import { getBackend as getMemoryBackendImpl } from "./memory-backend";
import { SupabaseBackend } from "./supabase-backend";
import { isSupabaseConfigured } from "./supabase-client";

let singleton: BarryBackend | undefined;

/**
 * Picks the persistent (Supabase) backend when configured, otherwise falls
 * back to the in-memory one — same pattern as getConversationStore() in
 * src/lib/state/index.ts, and for the same reason: tests and local dev
 * without a Supabase project keep working unchanged.
 */
export function getBackend(): BarryBackend {
  if (singleton) return singleton;
  singleton = isSupabaseConfigured() ? new SupabaseBackend() : getMemoryBackendImpl();
  return singleton;
}
