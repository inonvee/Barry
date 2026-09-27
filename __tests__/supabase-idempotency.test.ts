import { describe, expect, it } from "vitest";
import { isSupabaseConfigured, getSupabaseClient } from "@/lib/store/supabase-client";
import { SupabaseBackend } from "@/lib/store/supabase-backend";

/**
 * DB-level concurrency/idempotency guards added in
 * supabase/migrations/0002_idempotency.sql. These auto-skip unless
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set for this test run (see
 * supabase-persistence.test.ts) — verified directly against the live
 * database via the Supabase MCP tools as part of this change; this test
 * exists so the app-level code path (not just raw SQL) has coverage too.
 *
 * supabase/migrations/0003_function_search_path.sql pins
 * increment_inventory_consumed's search_path (a Supabase security-advisor
 * WARN: an unpinned search_path lets the CALLER's search_path at call time
 * decide which `inventory_adjustments` the function's unqualified
 * reference resolves to). No PostgREST-exposed way to assert this from
 * the app-level client, so it's verified live via the Supabase MCP
 * `get_advisors` tool instead of a test here.
 */
describe.skipIf(!isSupabaseConfigured())("Supabase idempotency constraints", () => {
  it("a second createBooking for the same resource+slot fails with a clean error, not a raw Postgres one", async () => {
    const backend = new SupabaseBackend();
    const businessId = "spa";
    const resourceId = `vitest-idem-${Date.now()}`;
    const start = "2031-01-01T09:00:00.000Z";
    const end = "2031-01-01T09:30:00.000Z";

    try {
      await backend.createBooking({
        businessId,
        offerId: "offer-x",
        resourceId,
        start,
        end,
        customerId: "c1",
        conversationId: "vitest-idem-conv-1",
        partySize: 1,
      });

      await expect(
        backend.createBooking({
          businessId,
          offerId: "offer-x",
          resourceId,
          start,
          end,
          customerId: "c2",
          conversationId: "vitest-idem-conv-2",
          partySize: 1,
        })
      ).rejects.toThrow(/slot no longer available/i);
    } finally {
      await getSupabaseClient().from("bookings").delete().eq("resource_id", resourceId);
    }
  });

  it("a second pending payment request for the same conversation fails with a clean error", async () => {
    const backend = new SupabaseBackend();
    const conversationId = `vitest-idem-pay-${Date.now()}`;

    try {
      await backend.createPaymentRequest({
        businessId: "spa",
        conversationId,
        customerId: "c1",
        amount: 50,
        currency: "USD",
        reason: "first",
      });

      await expect(
        backend.createPaymentRequest({
          businessId: "spa",
          conversationId,
          customerId: "c1",
          amount: 50,
          currency: "USD",
          reason: "retry",
        })
      ).rejects.toThrow(/already pending/i);
    } finally {
      await getSupabaseClient().from("payment_requests").delete().eq("conversation_id", conversationId);
    }
  });

  it("decrementInventory accumulates atomically across repeated calls", async () => {
    const backend = new SupabaseBackend();
    const businessId = "spa";
    const sku = `vitest-idem-sku-${Date.now()}`;

    try {
      await backend.decrementInventory(businessId, sku, 2);
      await backend.decrementInventory(businessId, sku, 3);
      const remaining = await backend.getInventory(businessId, sku, 10);
      expect(remaining).toBe(5); // 10 - (2 + 3)
    } finally {
      await getSupabaseClient().from("inventory_adjustments").delete().eq("sku", sku);
    }
  });
});
