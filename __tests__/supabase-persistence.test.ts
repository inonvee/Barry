import { describe, expect, it } from "vitest";
import { isSupabaseConfigured, getSupabaseClient } from "@/lib/store/supabase-client";
import { SupabaseConversationStore } from "@/lib/state/supabase-store";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { handleCustomerMessage } from "@/lib/runtime";

async function deleteConversation(id: string) {
  await getSupabaseClient().from("conversations").delete().eq("id", id);
}

/**
 * Proves conversations survive across separate calls that don't share any
 * JS object/singleton — i.e. what actually happens between two Vercel
 * serverless invocations. Each "request" below constructs a brand-new
 * SupabaseConversationStore instance and re-fetches from Postgres, instead
 * of reusing an in-memory object.
 *
 * Skipped automatically unless SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are
 * set, so the rest of the suite (and CI without a Supabase project) is
 * unaffected.
 */
describe.skipIf(!isSupabaseConfigured())("Supabase-backed persistence", () => {
  it("keeps conversation state across independent store instances", async () => {
    const conversationId = `vitest-persist-${Date.now()}`;
    const businessId = "spa";
    const customerId = "vitest-customer";

    try {
      const store1 = new SupabaseConversationStore();
      const state1 = await store1.getOrCreate(conversationId, businessId, customerId);
      state1.knownFields.__mentionedEarliest = "2026-10-04T13:00:00.000Z";
      state1.stage = "scheduling";
      await store1.save(state1);

      // Brand-new instance, no shared memory with store1.
      const store2 = new SupabaseConversationStore();
      const reloaded = await store2.get(conversationId);
      expect(reloaded).toBeDefined();
      expect(reloaded!.knownFields.__mentionedEarliest).toBe("2026-10-04T13:00:00.000Z");
      expect(reloaded!.stage).toBe("scheduling");
    } finally {
      await deleteConversation(conversationId);
    }
  });

  it("runs a real multi-turn conversation through the runtime against Supabase and survives a simulated cold start", async () => {
    const graph = buildSpaGraph();
    const conv = `vitest-runtime-${Date.now()}`;
    const customer = "vitest-runtime-customer";

    try {
      const t1 = await handleCustomerMessage(graph, conv, customer, "Couples massage Sunday around one");
      expect(t1.state.selectedOfferId).toBe("offer-couples-massage");

      // Reload straight from Postgres — nothing about this call reuses t1's
      // in-memory object.
      const store = new SupabaseConversationStore();
      const reloaded = await store.get(conv);
      expect(reloaded?.messages.length).toBe(2);
      expect(reloaded?.turns.length).toBe(1);

      const t2 = await handleCustomerMessage(graph, conv, customer, "Jordan Lee");
      expect(t2.state.knownFields.name).toBe("Jordan Lee");
      expect(t2.state.messages.length).toBe(4);
    } finally {
      await deleteConversation(conv);
    }
  });
});
