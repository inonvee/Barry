import { getBackend } from "@/lib/store";
import { FLEET_SCOPE } from "@/lib/release/manifest";
import { fleetTenant, fleetTenantIds } from "@/lib/hq/fleet";
import { loadControls } from "@/lib/hq/controls";
import { isDemoBusiness } from "@/lib/fixtures";
import { runInitiativeScan } from "./engine";

/**
 * INITIATIVE SCHEDULER — decides WHICH business is due for a scan and WHEN; the Initiative Engine
 * (runInitiativeScan) still decides everything else: detection, verification, dedupe, fatigue, ranking,
 * persistence and the per-day scan limit. The scheduler never forces, never sends a message and never
 * touches an external system: a scan only reads records.
 *
 * SLOTS — three business-local windows, so a business gets 2–3 useful scans a day, not constant polling:
 *   morning   08:00–12:59   afternoon 13:00–17:59   evening 18:00–21:59      (nothing 22:00–07:59)
 * The slot of a moment is read from the BUSINESS'S OWN timezone (Intl, so DST and date rollover are the
 * platform's, nothing hardcoded). A tick is meant to run about hourly; the first tick inside a window runs
 * that window's scan. A window that passed with no tick is not made up later (bounded, never a burst).
 *
 * IDEMPOTENCY — one durable record per (business, local date, slot) in the existing operator-records store
 * (kind "founder_state", business scope, key `initiative_slot:<date>:<slot>`), written as "claimed" BEFORE the
 * scan and finished as "ran" / "failed". A repeated tick sees "ran" and skips; a "claimed" record younger than
 * CLAIM_TTL_MS means a run is in flight; a failed slot may retry (MAX_ATTEMPTS). Each tick also leaves one
 * fleet-scope audit record (who was evaluated / due / ran / skipped, and why).
 */

export type SlotId = "morning" | "afternoon" | "evening";
export const SLOTS: { id: SlotId; startHour: number; endHour: number }[] = [
  { id: "morning", startHour: 8, endHour: 13 },
  { id: "afternoon", startHour: 13, endHour: 18 },
  { id: "evening", startHour: 18, endHour: 22 },
];
export const CLAIM_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 2;
const SLOT_PREFIX = "initiative_slot:";
const TICK_PREFIX = "initiative_tick:";

/** The business-local date and hour of a moment, read in the business's own timezone. */
export function localMoment(timezone: string, at: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** The slot a business-local moment falls in, or null overnight. */
export function slotAt(timezone: string, at: Date): { date: string; slot: SlotId } | null {
  const { date, hour } = localMoment(timezone, at);
  const s = SLOTS.find((x) => hour >= x.startHour && hour < x.endHour);
  return s ? { date, slot: s.id } : null;
}

export type SlotState = { businessId: string; localDate: string; slot: SlotId; status: "claimed" | "ran" | "failed"; attempts: number; claimedAt: string; finishedAt?: string; scanId?: string; engineSkipped?: string | null; counts?: { candidates: number; verified: number; rejected: number; created: number; updated: number; surfaced: number }; error?: string };

export type TickOutcome = { businessId: string; businessName: string; timezone: string; localDate: string | null; localHour: number | null; slot: SlotId | null; decision: "ran" | "skipped" | "failed"; reason: string; scanId?: string; engineSkipped?: string | null; counts?: SlotState["counts"] };
export type TickRecord = { at: string; evaluated: number; due: number; ran: number; skipped: number; failed: number; outcomes: TickOutcome[] };

const slotKey = (date: string, slot: SlotId) => `${SLOT_PREFIX}${date}:${slot}`;

async function loadSlot(businessId: string, date: string, slot: SlotId): Promise<SlotState | undefined> {
  const r = (await getBackend().listOperatorRecords(businessId, "founder_state")).find((x) => x.key === slotKey(date, slot));
  return r?.data as unknown as SlotState | undefined;
}
async function saveSlot(s: SlotState): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: s.businessId, kind: "founder_state", key: slotKey(s.localDate, s.slot), data: s });
}

export async function listSlotStates(businessId: string): Promise<SlotState[]> {
  return (await getBackend().listOperatorRecords(businessId, "founder_state")).filter((r) => r.key.startsWith(SLOT_PREFIX)).map((r) => r.data as unknown as SlotState).sort((a, b) => b.claimedAt.localeCompare(a.claimedAt));
}
export async function listTicks(limit = 24): Promise<TickRecord[]> {
  return (await getBackend().listOperatorRecords(FLEET_SCOPE, "founder_state")).filter((r) => r.key.startsWith(TICK_PREFIX)).map((r) => r.data as unknown as TickRecord).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

async function evaluate(businessId: string, now: Date): Promise<TickOutcome> {
  const graph = fleetTenant(businessId);
  const base = { businessId, businessName: graph?.business.name ?? businessId, timezone: graph?.business.timezone ?? "", localDate: null as string | null, localHour: null as number | null, slot: null as SlotId | null };
  const skip = (reason: string, extra: Partial<TickOutcome> = {}): TickOutcome => ({ ...base, decision: "skipped", reason, ...extra });
  try {
    if (!graph) return skip("unknown business");
    if (isDemoBusiness(businessId)) return skip("demo business (not scanned)");
    const lm = localMoment(graph.business.timezone, now);
    base.localDate = lm.date;
    base.localHour = lm.hour;
    const at = slotAt(graph.business.timezone, now);
    if (!at) return skip(`outside scan windows (local ${String(lm.hour).padStart(2, "0")}:xx; windows 08–22)`);
    base.slot = at.slot;
    if ((await loadControls(businessId)).pausedBusiness) return skip("business is paused — nothing proactive runs");
    const prior = await loadSlot(businessId, at.date, at.slot);
    if (prior?.status === "ran") return skip(`slot ${at.date} ${at.slot} already ran`, { scanId: prior.scanId });
    if (prior?.status === "claimed" && now.getTime() - Date.parse(prior.claimedAt) < CLAIM_TTL_MS) return skip(`slot ${at.date} ${at.slot} is being run by another tick`);
    if (prior?.status === "failed" && prior.attempts >= MAX_ATTEMPTS) return skip(`slot ${at.date} ${at.slot} failed ${prior.attempts} times — not retried this slot`);
    const attempts = (prior?.attempts ?? 0) + 1;
    const state: SlotState = { businessId, localDate: at.date, slot: at.slot, status: "claimed", attempts, claimedAt: now.toISOString() };
    await saveSlot(state);
    try {
      // The ONE existing scan path. Never forced: the engine's daily limit always wins.
      const { scan } = await runInitiativeScan(graph, { now, trigger: "scheduled", force: false });
      const counts = { candidates: scan.candidates, verified: scan.verified, rejected: scan.rejected.length, created: scan.created, updated: scan.updated, surfaced: scan.surfaced };
      await saveSlot({ ...state, status: "ran", finishedAt: new Date().toISOString(), scanId: scan.id, engineSkipped: scan.skipped ?? null, counts });
      return { ...base, decision: "ran", reason: scan.skipped ? `scan ran but the engine skipped it: ${scan.skipped}` : scan.verified === 0 ? "scan ran; nothing to act on (success)" : "scan ran", scanId: scan.id, engineSkipped: scan.skipped ?? null, counts };
    } catch (err) {
      const message = (err instanceof Error ? err.message : "scan failed").slice(0, 200);
      await saveSlot({ ...state, status: "failed", finishedAt: new Date().toISOString(), error: message }).catch(() => undefined);
      return { ...base, decision: "failed", reason: message };
    }
  } catch (err) {
    return { ...base, decision: "failed", reason: (err instanceof Error ? err.message : "evaluation failed").slice(0, 200) };
  }
}

/**
 * One scheduler tick: evaluate every fleet business (or only `businessId`), run the due ones through the
 * Initiative Engine one at a time, and record the tick. One business failing never stops the rest.
 */
export async function runInitiativeTick(opts: { now?: Date; businessId?: string } = {}): Promise<TickRecord> {
  const now = opts.now ?? new Date();
  const ids = (opts.businessId ? [opts.businessId] : fleetTenantIds()).filter((id, i, a) => a.indexOf(id) === i);
  const outcomes: TickOutcome[] = [];
  for (const id of ids) outcomes.push(await evaluate(id, now));
  const ran = outcomes.filter((o) => o.decision === "ran").length;
  const failed = outcomes.filter((o) => o.decision === "failed").length;
  // "due" = a slot was open for this business and a scan was attempted (ran or failed); the rest were skipped, each with its reason.
  const tick: TickRecord = { at: now.toISOString(), evaluated: outcomes.length, due: ran + failed, ran, skipped: outcomes.filter((o) => o.decision === "skipped").length, failed, outcomes };
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: "founder_state", key: `${TICK_PREFIX}${now.toISOString()}`, data: tick }).catch(() => undefined);
  return tick;
}
