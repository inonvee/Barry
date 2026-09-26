export * from "./types";
export { MemoryBackend, getBackend as getMemoryBackend } from "./memory-backend";
export { SupabaseBackend } from "./supabase-backend";
export { isSupabaseConfigured } from "./supabase-client";

import type { BarryBackend } from "./types";
import { getBackend as getMemoryBackendImpl } from "./memory-backend";
import { SupabaseBackend } from "./supabase-backend";
import { isSupabaseConfigured } from "./supabase-client";
import { BarryConfigurationError, isProductionRuntime } from "@/lib/env";

let singleton: BarryBackend | undefined;

/**
 * Picks the persistent (Supabase) backend when configured; in local dev /
 * tests, falls back to the in-memory one when it isn't. Same production
 * guard as getConversationStore() in src/lib/state/index.ts, and for the
 * same reason: a real deployment must never silently run bookings,
 * payments, and approvals on process memory that vanishes on the next
 * cold start.
 */
export function getBackend(): BarryBackend {
  if (singleton) return singleton;

  if (isProductionRuntime() && !isSupabaseConfigured()) {
    throw new BarryConfigurationError(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production. " +
        "Refusing to silently run bookings/payments/approvals on in-memory state."
    );
  }

  singleton = isSupabaseConfigured() ? new SupabaseBackend() : getMemoryBackendImpl();
  return singleton;
}
