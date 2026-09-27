import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { createInitialConversationState } from "@/lib/state";
import { compile } from "@/lib/runtime/compiler";
import { callTool } from "@/lib/tools";
import { MemoryBackend } from "@/lib/store/memory-backend";
import { MemorySchedulingAdapter } from "@/lib/scheduling/adapters/memory";
import { GoogleCalendarAdapter, googleCalendarEventIdForSlotLock } from "@/lib/scheduling/adapters/google-calendar";

const iso = (s: string | number) => new Date(s).toISOString();

describe("MemorySchedulingAdapter", () => {
  it("prefers the exact requested slot when it is available", async () => {
    const graph = buildSpaGraph();
    const backend = new MemoryBackend();
    const adapter = new MemorySchedulingAdapter(backend);
    const exact = graph.availability.find((s) => s.resourceId === "therapist-1")!;

    const result = await adapter.checkAvailability({
      graph,
      offerId: "offer-couples-massage",
      earliest: exact.start,
      latest: iso(new Date(exact.start).getTime() + 3 * 60 * 60 * 1000),
      partySize: 2,
    });

    expect(result.slots[0]).toEqual({ resourceId: exact.resourceId, start: exact.start, end: exact.end });
  });

  it("does not offer a slot that has already been booked", async () => {
    const graph = buildSpaGraph();
    const backend = new MemoryBackend();
    const adapter = new MemorySchedulingAdapter(backend);
    const exact = graph.availability.find((s) => s.resourceId === "therapist-1")!;

    await adapter.createBooking({
      graph,
      offerId: "offer-couples-massage",
      resourceId: exact.resourceId,
      start: exact.start,
      end: exact.end,
      customerId: "cust-1",
      conversationId: "conv-1",
      partySize: 2,
      idempotencyKey: "booking-1",
    });

    const result = await adapter.checkAvailability({
      graph,
      offerId: "offer-couples-massage",
      earliest: exact.start,
      latest: exact.end,
      partySize: 2,
    });

    expect(result.slots).not.toContainEqual({ resourceId: exact.resourceId, start: exact.start, end: exact.end });
  });

  it("is idempotent for duplicate booking retries and rejects a different request for the same slot", async () => {
    const graph = buildSpaGraph();
    const backend = new MemoryBackend();
    const adapter = new MemorySchedulingAdapter(backend);
    const exact = graph.availability.find((s) => s.resourceId === "therapist-1")!;
    const request = {
      graph,
      offerId: "offer-couples-massage",
      resourceId: exact.resourceId,
      start: exact.start,
      end: exact.end,
      customerId: "cust-1",
      conversationId: "conv-1",
      partySize: 2,
      idempotencyKey: "same-request",
    };

    const first = await adapter.createBooking(request);
    const retry = await adapter.createBooking(request);
    expect(retry.bookingId).toBe(first.bookingId);
    expect(await backend.listBookings(graph.business.id)).toHaveLength(1);

    await expect(
      adapter.createBooking({ ...request, customerId: "cust-2", conversationId: "conv-2", idempotencyKey: "different-request" })
    ).rejects.toThrow(/Slot no longer available/);
  });
});

describe("GoogleCalendarAdapter", () => {
  it("generates deterministic provider event IDs using only Google Calendar's allowed base32hex characters", () => {
    const id = googleCalendarEventIdForSlotLock("spa:therapist-1:2026-06-15T13:00:00.000Z:2026-06-15T14:00:00.000Z");
    const same = googleCalendarEventIdForSlotLock("spa:therapist-1:2026-06-15T13:00:00.000Z:2026-06-15T14:00:00.000Z");
    const other = googleCalendarEventIdForSlotLock("spa:therapist-2:2026-06-15T13:00:00.000Z:2026-06-15T14:00:00.000Z");

    expect(id).toBe(same);
    expect(id).not.toBe(other);
    expect(id).toMatch(/^[a-v0-9]+$/);
    expect(id.length).toBeGreaterThanOrEqual(5);
    expect(id.length).toBeLessThanOrEqual(1024);
  });

  it("filters Google busy blocks out of graph candidate availability", async () => {
    const graph = buildSpaGraph();
    const exact = graph.availability.find((s) => s.resourceId === "therapist-1")!;
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        calendars: {
          "cal-1": {
            busy: [{ start: exact.start, end: exact.end }],
          },
        },
      });
    };
    const backend = new MemoryBackend();
    const adapter = new GoogleCalendarAdapter({ calendarId: "cal-1", accessTokenProvider: async () => "token", fetcher, backend });

    const result = await adapter.checkAvailability({
      graph,
      offerId: "offer-couples-massage",
      earliest: exact.start,
      latest: exact.end,
      partySize: 2,
    });

    expect(result.slots).toEqual([]);
    expect(calls[0].url).toContain("/freeBusy");
  });

  it("creates one event, verifies it exists, and returns the provider event id", async () => {
    const graph = buildSpaGraph();
    const exact = graph.availability.find((s) => s.resourceId === "therapist-1")!;
    const calls: string[] = [];
    let eventExists = false;
    const fetcher: typeof fetch = async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).includes("/freeBusy")) return Response.json({ calendars: { "cal-1": { busy: [] } } });
      if (init?.method === "POST") {
        eventExists = true;
        return Response.json({ id: "barryslot1", status: "confirmed" });
      }
      if (!eventExists) return new Response("not found", { status: 404 });
      return Response.json({ id: "barryslot1", status: "confirmed" });
    };
    const backend = new MemoryBackend();
    const adapter = new GoogleCalendarAdapter({ calendarId: "cal-1", accessTokenProvider: async () => "token", fetcher, backend });

    const booking = await adapter.createBooking({
      graph,
      offerId: "offer-couples-massage",
      resourceId: exact.resourceId,
      start: exact.start,
      end: exact.end,
      customerId: "cust-1",
      conversationId: "conv-1",
      partySize: 2,
      idempotencyKey: "same-request",
    });

    expect(booking.providerEventId).toBe("barryslot1");
    expect((await backend.listBookings(graph.business.id))[0].providerEventId).toBe("barryslot1");
    expect(calls.some((c) => c.startsWith("POST"))).toBe(true);
    expect(calls.some((c) => c.startsWith("GET"))).toBe(true);
  });

  it("fails safely when Google is unavailable", async () => {
    const graph = buildSpaGraph();
    const exact = graph.availability.find((s) => s.resourceId === "therapist-1")!;
    const adapter = new GoogleCalendarAdapter({
      calendarId: "cal-1",
      accessTokenProvider: async () => "token",
      fetcher: async () => new Response("unavailable", { status: 503 }),
    });

    await expect(
      adapter.checkAvailability({
        graph,
        offerId: "offer-couples-massage",
        earliest: exact.start,
        latest: exact.end,
        partySize: 2,
      })
    ).rejects.toThrow(/provider unavailable/i);
  });
});

describe("Scheduling tools stay behind compiler/policy/tool registry", () => {
  it("runtime tool path creates a verified booking record through the scheduling capability", async () => {
    const graph = buildSpaGraph();
    const state = createInitialConversationState("phase2-tools", graph.business.id, "cust-phase2");
    const exact = graph.availability.find((s) => s.resourceId === "therapist-1")!;

    const outcome = compile(graph, state, {
      intent: "booking",
      selectedOfferId: "offer-couples-massage",
      entities: {},
      constraints: {},
      customerInfo: { name: "Inon", phone: "0558832177" },
    });
    expect(outcome.kind).toBe("ask_datetime");

    const result = await callTool(
      "createBooking",
      { offerId: "offer-couples-massage", resourceId: exact.resourceId, start: exact.start, end: exact.end, partySize: 2 },
      { graph, conversationId: "phase2-tools", customerId: "cust-phase2" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toMatchObject({ status: "confirmed" });
  });
});
