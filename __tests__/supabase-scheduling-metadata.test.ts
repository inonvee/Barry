import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSupabaseConfigured, getSupabaseClient } from "@/lib/store/supabase-client";
import { SupabaseBackend } from "@/lib/store/supabase-backend";

describe("Supabase real scheduling metadata migration", () => {
  it("declares provider metadata columns and durable idempotency indexes", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0005_real_scheduling_metadata.sql"), "utf8");

    expect(sql).toMatch(/provider\s+text/i);
    expect(sql).toMatch(/provider_event_id\s+text/i);
    expect(sql).toMatch(/idempotency_key\s+text/i);
    expect(sql).toMatch(/verified_at\s+timestamptz/i);
    expect(sql).toMatch(/bookings_provider_event_idx/i);
    expect(sql).toMatch(/bookings_idempotency_key_confirmed_uidx/i);
    expect(sql).not.toMatch(/drop\s+index.*bookings_resource_slot_confirmed_uidx/i);
  });
});

describe.skipIf(!isSupabaseConfigured())("Supabase booking provider metadata persistence", () => {
  it("persists and reloads real scheduling provider metadata", async () => {
    const backend = new SupabaseBackend();
    const resourceId = `vitest-provider-${Date.now()}`;
    const idempotencyKey = `vitest-idem-${Date.now()}`;

    try {
      const booking = await backend.createBooking({
        businessId: "spa",
        offerId: "offer-x",
        resourceId,
        start: "2031-01-02T09:00:00.000Z",
        end: "2031-01-02T10:00:00.000Z",
        customerId: "cust-provider",
        conversationId: "conv-provider",
        partySize: 1,
        provider: "google-calendar",
        providerEventId: "barr1234",
        idempotencyKey,
        verifiedAt: "2031-01-02T08:59:00.000Z",
      });

      expect(booking.provider).toBe("google-calendar");
      expect(booking.providerEventId).toBe("barr1234");
      expect(booking.idempotencyKey).toBe(idempotencyKey);
      expect(booking.verifiedAt).toBe("2031-01-02T08:59:00.000Z");

      await expect(
        backend.createBooking({
          businessId: "spa",
          offerId: "offer-x",
          resourceId: `${resourceId}-other`,
          start: "2031-01-03T09:00:00.000Z",
          end: "2031-01-03T10:00:00.000Z",
          customerId: "cust-provider",
          conversationId: "conv-provider",
          partySize: 1,
          provider: "google-calendar",
          providerEventId: "barr5678",
          idempotencyKey,
          verifiedAt: "2031-01-03T08:59:00.000Z",
        })
      ).rejects.toThrow(/already exists|slot no longer available/i);
    } finally {
      await getSupabaseClient().from("bookings").delete().eq("resource_id", resourceId);
      await getSupabaseClient().from("bookings").delete().eq("idempotency_key", idempotencyKey);
    }
  });
});
