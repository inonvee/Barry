import { afterEach, describe, expect, it, vi } from "vitest";
import "@/lib/fabric";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { fleetTenant } from "@/lib/hq/fleet";
import { applyControlChange, resetControlsCacheForTests } from "@/lib/hq/controls";
import * as engine from "@/lib/initiative/engine";
import { listScans } from "@/lib/initiative/store";
import { listSlotStates, listTicks, runInitiativeTick, slotAt, localMoment } from "@/lib/initiative/scheduler";
import { GET as cronGet } from "@/app/api/cron/initiative-scan/route";

/**
 * INITIATIVE SCHEDULER — decides which business is due and when (business-local slots); the Initiative
 * Engine decides everything else. Idempotent per (business, local date, slot), the engine's daily limit
 * always wins, one business failing never blocks another, and nothing is ever sent.
 *
 * Fixture timezones: Rina = Asia/Jerusalem, bags = America/Los_Angeles, furniture = America/New_York,
 * garage = America/Chicago, trainer = America/Denver. 2026-10-14 is before Israel's DST end (UTC+3).
 */
const RINA = "fashion-retailer";
const BAGS = "ecommerce-bags";
const FURN = "furniture-store";
const GARAGE = "garage";
const Z = (iso: string) => new Date(`${iso}Z`);
const real = async (id: string, date?: string) => (await listScans(id)).filter((s) => !s.skipped && (!date || s.localDate === date));
afterEach(() => {
  vi.restoreAllMocks();
  resetControlsCacheForTests();
});

describe("business-local slots", () => {
  it("reads the slot from the business's own timezone — DST-correct, nothing hardcoded", () => {
    expect(slotAt("Asia/Jerusalem", Z("2026-10-14T04:59:00"))).toBeNull(); // 07:59 local
    expect(slotAt("Asia/Jerusalem", Z("2026-10-14T05:00:00"))).toEqual({ date: "2026-10-14", slot: "morning" }); // 08:00
    expect(slotAt("Asia/Jerusalem", Z("2026-10-14T10:00:00"))?.slot).toBe("afternoon"); // 13:00
    expect(slotAt("Asia/Jerusalem", Z("2026-10-14T15:00:00"))?.slot).toBe("evening"); // 18:00
    expect(slotAt("Asia/Jerusalem", Z("2026-10-14T19:00:00"))).toBeNull(); // 22:00
    // After DST ends (UTC+2) the same UTC instant is an hour earlier locally.
    expect(slotAt("Asia/Jerusalem", Z("2026-11-03T06:00:00"))?.slot).toBe("morning"); // 08:00 local
    expect(slotAt("Asia/Jerusalem", Z("2026-11-03T05:59:00"))).toBeNull(); // 07:59 local
  });

  it("date rollover: the local date moves at local midnight, not UTC midnight", () => {
    const t = Z("2026-10-14T21:30:00");
    expect(localMoment("Asia/Jerusalem", t)).toEqual({ date: "2026-10-15", hour: 0 });
    expect(slotAt("Asia/Jerusalem", t)).toBeNull();
    expect(slotAt("America/Los_Angeles", t)).toEqual({ date: "2026-10-14", slot: "afternoon" }); // 14:30 local, still the 14th
  });
});

describe("a tick", () => {
  it("scans only the businesses whose local slot is due, each in its own timezone, and audits every decision", async () => {
    const at = Z("2026-11-03T14:00:00"); // Jerusalem 16:00 afternoon · LA 06:00 · NY 09:00 · Chicago 08:00 · Denver 07:00
    const tick = await runInitiativeTick({ now: at });
    const by = (id: string) => tick.outcomes.find((o) => o.businessId === id)!;
    expect(by(RINA)).toMatchObject({ decision: "ran", slot: "afternoon", localDate: "2026-11-03" });
    expect(by(FURN)).toMatchObject({ decision: "ran", slot: "morning" });
    expect(by(GARAGE)).toMatchObject({ decision: "ran", slot: "morning" });
    expect(by(BAGS)).toMatchObject({ decision: "skipped" });
    expect(by(BAGS).reason).toMatch(/outside scan windows/);
    expect(by("personal-trainer").decision).toBe("skipped");
    expect(tick.evaluated).toBe(tick.outcomes.length);
    expect(tick.due).toBe(tick.ran + tick.failed);
    expect((await listTicks(1))[0].at).toBe(at.toISOString());
    expect((await real(RINA)).every((s) => s.trigger === "scheduled")).toBe(true);
    expect((await real(BAGS)).length).toBe(0);
  });

  it("the same slot never runs twice; the next slot later that day can; repeated invocation is idempotent", async () => {
    const spy = vi.spyOn(engine, "runInitiativeScan");
    await runInitiativeTick({ now: Z("2026-10-14T05:10:00"), businessId: RINA }); // morning
    expect(spy).toHaveBeenCalledTimes(1);
    for (const t of ["2026-10-14T05:10:00", "2026-10-14T05:40:00", "2026-10-14T07:00:00"]) {
      const again = await runInitiativeTick({ now: Z(t), businessId: RINA });
      expect(again.outcomes[0]).toMatchObject({ decision: "skipped" });
      expect(again.outcomes[0].reason).toMatch(/already ran/);
    }
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await real(RINA, "2026-10-14")).toHaveLength(1);
    // 13:05 local → the afternoon slot is a new slot.
    const later = await runInitiativeTick({ now: Z("2026-10-14T10:05:00"), businessId: RINA });
    expect(later.outcomes[0]).toMatchObject({ decision: "ran", slot: "afternoon" });
    expect(await real(RINA, "2026-10-14")).toHaveLength(2);
    const slots = (await listSlotStates(RINA)).filter((s) => s.localDate === "2026-10-14");
    expect(slots.map((s) => s.slot).sort()).toEqual(["afternoon", "morning"]);
    expect(slots.every((s) => s.status === "ran" && s.scanId)).toBe(true);
  });

  it("an empty scan is a success", async () => {
    const due = await runInitiativeTick({ now: Z("2026-10-20T14:00:00"), businessId: GARAGE }); // Chicago 09:00
    expect(due.outcomes[0].decision).toBe("ran");
    expect(due.outcomes[0].reason).toMatch(/nothing to act on \(success\)/);
    expect(due.failed).toBe(0);
  });

  it("the engine's daily limit still wins, and the scheduler never forces", async () => {
    const g = fleetTenant(FURN)!;
    const day = Z("2026-10-21T14:00:00"); // NY 10:00
    for (let i = 0; i < 3; i++) await engine.runInitiativeScan(g, { now: day, trigger: "manual" });
    const spy = vi.spyOn(engine, "runInitiativeScan");
    const tick = await runInitiativeTick({ now: day, businessId: FURN });
    expect(spy.mock.calls[0][1]).toMatchObject({ trigger: "scheduled", force: false });
    expect(tick.outcomes[0].decision).toBe("ran");
    expect(tick.outcomes[0].engineSkipped).toMatch(/scan limit reached/);
    expect(await real(FURN, "2026-10-21")).toHaveLength(3);
  });

  it("one business failing does not abort the rest, and a failed slot may retry (bounded)", async () => {
    const real_ = engine.runInitiativeScan;
    const spy = vi.spyOn(engine, "runInitiativeScan").mockImplementation(async (graph, opts) => {
      if (graph.business.id === RINA) throw new Error("store unavailable");
      return real_(graph, opts);
    });
    const at = Z("2026-10-22T14:00:00"); // Jerusalem 17:00 · NY 10:00 · Chicago 09:00
    const tick = await runInitiativeTick({ now: at });
    const by = (id: string) => tick.outcomes.find((o) => o.businessId === id)!;
    expect(by(RINA)).toMatchObject({ decision: "failed", reason: "store unavailable" });
    expect(by(FURN).decision).toBe("ran");
    expect(by(GARAGE).decision).toBe("ran");
    expect(tick.failed).toBe(1);
    expect(tick.ran).toBeGreaterThanOrEqual(2);
    // Retry #2 may run (and fail again); the third is refused for this slot.
    expect((await runInitiativeTick({ now: Z("2026-10-22T14:30:00"), businessId: RINA })).outcomes[0].decision).toBe("failed");
    const third = await runInitiativeTick({ now: Z("2026-10-22T14:50:00"), businessId: RINA });
    expect(third.outcomes[0].decision).toBe("skipped");
    expect(third.outcomes[0].reason).toMatch(/not retried/);
    spy.mockRestore();
    // The rest of the fleet's slots were not re-run.
    expect((await runInitiativeTick({ now: Z("2026-10-22T15:00:00"), businessId: FURN })).outcomes[0].reason).toMatch(/already ran/);
  });

  it("a paused business is not scanned (nothing proactive runs)", async () => {
    await applyControlChange(GARAGE, { pausedBusiness: true }, { by: "founder", reason: "test pause" });
    const t = await runInitiativeTick({ now: Z("2026-10-23T14:00:00"), businessId: GARAGE });
    expect(t.outcomes[0]).toMatchObject({ decision: "skipped" });
    expect(t.outcomes[0].reason).toMatch(/paused/);
    await applyControlChange(GARAGE, { pausedBusiness: false }, { by: "founder", reason: "test resume" });
  });

  it("emits no customer messages or external actions: no conversations, approvals or payments change", async () => {
    const ids = [RINA, FURN, GARAGE, BAGS];
    const snapshot = async () => JSON.stringify(await Promise.all(ids.map(async (id) => [(await getConversationStore().listByBusiness(id)).length, (await getBackend().listApprovals(id)).length, (await getBackend().listPaymentRequests(id)).length, (await getBackend().listOperatorRecords(id, "owner_brief")).length, (await getBackend().listOperatorRecords(id, "execution_attempt")).length])));
    const before = await snapshot();
    await runInitiativeTick({ now: Z("2026-10-24T14:00:00") });
    await runInitiativeTick({ now: Z("2026-10-24T14:00:00") });
    expect(await snapshot()).toBe(before);
  });
});

describe("the tick route", () => {
  const url = "http://x/api/cron/initiative-scan";
  it("is closed without credentials; the cron secret runs a real-time tick; only the founder can pick the moment or business", async () => {
    process.env.BARRY_FOUNDER_TOKEN = "founder-test-token-that-is-long-enough-123456";
    delete process.env.CRON_SECRET;
    expect((await cronGet(new Request(url))).status).toBe(401);
    expect((await cronGet(new Request(url, { headers: { authorization: "Bearer anything-at-all-1234567890" } }))).status).toBe(401);
    process.env.CRON_SECRET = "cron-secret-for-tests-0123456789";
    expect((await cronGet(new Request(url, { headers: { authorization: "Bearer wrong-secret-0123456789abcdef" } }))).status).toBe(401);
    const ok = await cronGet(new Request(`${url}?at=2026-10-14T05:00:00Z&businessId=${RINA}`, { headers: { authorization: "Bearer cron-secret-for-tests-0123456789" } }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { tick: { evaluated: number; outcomes: { slot: string | null }[] }; recent?: unknown };
    // The cron secret cannot pick the moment or the business: the whole fleet is evaluated at real time.
    expect(body.tick.evaluated).toBeGreaterThan(1);
    expect(body.recent).toBeUndefined();
    const founder = await cronGet(new Request(`${url}?at=2026-12-01T06:00:00Z&businessId=${RINA}`, { headers: { authorization: `Bearer ${process.env.BARRY_FOUNDER_TOKEN}` } }));
    const f = (await founder.json()) as { tick: { evaluated: number; ran: number; outcomes: { businessId: string; slot: string }[] }; recent: unknown[] };
    expect(f.tick.evaluated).toBe(1);
    expect(f.tick.outcomes[0]).toMatchObject({ businessId: RINA, slot: "morning" });
    expect(f.recent.length).toBeGreaterThan(0);
    delete process.env.CRON_SECRET;
  });
});
