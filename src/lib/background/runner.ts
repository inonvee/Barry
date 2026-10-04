import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { FLEET_SCOPE } from "@/lib/release/manifest";
import { fleetTenant, fleetTenantIds } from "@/lib/hq/fleet";
import { loadControls, type BusinessControls } from "@/lib/hq/controls";
import { isDemoBusiness } from "@/lib/fixtures";
import { operatingMode, proactiveGate, type OperatingMode } from "@/lib/runtime/operating-mode";
import { runObligationExecutor, type SenderResolver } from "@/lib/operator/executor";
import { listAttempts } from "@/lib/operator/attempts";
import { notifyOwnerAttention, notifyOwnerDecisions, sendDailyBrief } from "@/lib/owner/briefs";
import { runInitiativeTick, localMoment } from "@/lib/initiative/scheduler";
import { whatsappConfig, whatsappSender } from "@/lib/channels/whatsapp";
import { ConversationBusyError, withConversationLock } from "@/lib/state/lock";

/**
 * BACKGROUND OPERATION — the one recurring runner for the work BARRY does without a customer writing:
 *
 *   followups        payment follow-ups, abandoned-checkout recovery, reminders (the obligation executor)
 *   owner_brief      the owner's daily brief (owner line)
 *   owner_alerts     hourly safety net for owner notifications (decisions waiting, a customer needs a person,
 *                    an important failure, a failed payment) — each item announced once, ever
 *   initiative_scan  the Initiative Engine's scans (its own slot scheduler; reads only)
 *
 * Built on what exists: the obligation executor (authority, idempotent attempts, 24h window, handoffs),
 * the brief's per-local-day dedupe, the initiative slot scheduler. This file adds the schedule, the limits,
 * the mode gate and the log.
 *
 *  - BUSINESS-LOCAL TIME: every window and every "day" is read in the business's own timezone (Intl).
 *  - ONE RUN PER SLOT: a durable job record per (business, job, slot) — claimed BEFORE the work, finished as
 *    ran / failed / skipped. A finished slot never runs again; a failed one retries on a later tick in the same
 *    slot (MAX_ATTEMPTS), then stays failed — visible, never silently dropped.
 *  - ONE RUNNER AT A TIME: the job runs holding a database lease (`bg:<business>:<job>`, the same lock
 *    table as conversations), so two ticks on two instances never run the same job together.
 *  - NO DUPLICATE SENDS: every follow-up attempt is recorded before its send and re-checked under the
 *    conversation's lock (executor); a brief is keyed per business-local day.
 *  - LIMITS: at most RUN_LIMIT follow-ups per run and DAILY_PROACTIVE_LIMIT per business-local day.
 *  - MODE: PAUSED runs nothing outbound; SIMULATOR (test businesses) only dry-runs and never messages an
 *    owner; SUPERVISED prepares follow-ups but sends none on its own (the owner runs them); LIVE sends what
 *    authority permits. A dry run is logged as a dry run — never as activity that reached anyone.
 *  - Demo businesses are never run.
 */

export type JobId = "followups" | "owner_brief" | "owner_alerts" | "initiative_scan";
export const FOLLOWUP_HOURS = { start: 9, end: 20 } as const;
export const BRIEF_HOURS = { start: 8, end: 11 } as const;
export const RUN_LIMIT = 5;
export const DAILY_PROACTIVE_LIMIT = 20;
export const MAX_ATTEMPTS = 2;
export const CLAIM_TTL_MS = 10 * 60_000;
const JOB_PREFIX = "bg_job:";
const TICK_PREFIX = "bg_tick:";

export type JobSummary = { considered?: number; sent?: number; dryRun?: number; failed?: number; skipped?: number; cancelled?: number; briefs?: { sent: number; dryRun: number; blocked: number; failed: number }; initiative?: string };

export type JobRecord = {
  businessId: string;
  job: JobId;
  slot: string;
  status: "claimed" | "ran" | "failed";
  attempts: number;
  mode: OperatingMode;
  claimedAt: string;
  finishedAt?: string;
  summary?: JobSummary;
  /** Why the gate held it back (e.g. supervised), when it ran but sent nothing on purpose. */
  note?: string;
  error?: string;
  /** failed: will a later tick in this slot try again? */
  retry?: boolean;
};

export type JobOutcome = { businessId: string; job: JobId; slot: string | null; decision: "ran" | "skipped" | "failed"; reason: string; summary?: JobSummary };
export type BackgroundTick = { at: string; evaluated: number; ran: number; skipped: number; failed: number; outcomes: JobOutcome[] };

const jobKey = (job: JobId, slot: string) => `${JOB_PREFIX}${job}:${slot}`;

async function loadJob(businessId: string, job: JobId, slot: string): Promise<JobRecord | undefined> {
  const r = (await getBackend().listOperatorRecords(businessId, "founder_state")).find((x) => x.key === jobKey(job, slot));
  return r?.data as unknown as JobRecord | undefined;
}
async function saveJob(j: JobRecord): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: j.businessId, kind: "founder_state", key: jobKey(j.job, j.slot), data: j as unknown as Record<string, unknown> });
}

export async function listJobRuns(businessId: string): Promise<JobRecord[]> {
  return (await getBackend().listOperatorRecords(businessId, "founder_state")).filter((r) => r.key.startsWith(JOB_PREFIX)).map((r) => r.data as unknown as JobRecord).sort((a, b) => b.claimedAt.localeCompare(a.claimedAt));
}
export async function listBackgroundTicks(limit = 24): Promise<BackgroundTick[]> {
  return (await getBackend().listOperatorRecords(FLEET_SCOPE, "founder_state")).filter((r) => r.key.startsWith(TICK_PREFIX)).map((r) => r.data as unknown as BackgroundTick).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

let sendersForTests: SenderResolver | undefined;
export function setBackgroundSendersForTests(s: SenderResolver | undefined): void {
  sendersForTests = s;
}
/** The real customer channel — only ever used when the mode gate allows a live send (the executor re-checks). */
function liveSenders(): SenderResolver {
  if (sendersForTests) return sendersForTests;
  const wa = whatsappConfig();
  return (c) => (c.id.startsWith("wa:") && wa.sendMode === "live" ? whatsappSender() : undefined);
}

/** Proactive sends already made (or attempted) today, business-local — the daily budget. Dry runs don't count as sends. */
async function proactiveToday(graph: BusinessGraph, now: Date): Promise<number> {
  const today = localMoment(graph.business.timezone, now).date;
  return (await listAttempts(graph.business.id)).filter((a) => (a.status === "sent" || a.status === "attempted" || a.status === "failed") && localMoment(graph.business.timezone, new Date(a.at)).date === today).length;
}

type JobBody = (ctx: { graph: BusinessGraph; controls: BusinessControls; now: Date }) => Promise<{ summary: JobSummary; note?: string }>;

const JOBS: Record<Exclude<JobId, "initiative_scan">, { slot: (tz: string, now: Date) => string | null; window: string; run: JobBody }> = {
  followups: {
    window: `${FOLLOWUP_HOURS.start}:00–${FOLLOWUP_HOURS.end}:00 business-local, hourly`,
    slot: (tz, now) => {
      const m = localMoment(tz, now);
      return m.hour >= FOLLOWUP_HOURS.start && m.hour < FOLLOWUP_HOURS.end ? `${m.date}T${String(m.hour).padStart(2, "0")}` : null;
    },
    run: async ({ graph, controls, now }) => {
      const gate = proactiveGate(controls);
      const budget = Math.max(0, DAILY_PROACTIVE_LIMIT - (await proactiveToday(graph, now)));
      if (budget === 0) return { summary: { considered: 0 }, note: `daily limit reached (${DAILY_PROACTIVE_LIMIT} proactive messages per business per day)` };
      const run = await runObligationExecutor(graph, { now, limit: Math.min(RUN_LIMIT, budget), senders: gate.allowed && gate.live ? liveSenders() : undefined });
      const count = (o: string) => run.results.filter((r) => r.outcome === o).length;
      return { summary: { considered: run.considered, sent: count("sent"), dryRun: count("dry_run"), failed: count("failed"), skipped: count("skipped"), cancelled: count("cancelled") }, ...(run.blocked ? { note: run.blocked } : {}) };
    },
  },
  owner_brief: {
    window: `${BRIEF_HOURS.start}:00–${BRIEF_HOURS.end}:00 business-local, daily`,
    slot: (tz, now) => {
      const m = localMoment(tz, now);
      return m.hour >= BRIEF_HOURS.start && m.hour < BRIEF_HOURS.end ? m.date : null;
    },
    run: async ({ graph, controls, now }) => {
      const mode = operatingMode(controls);
      // A test / practice business never messages a real owner line.
      if (mode !== "supervised" && mode !== "live") return { summary: {}, note: `${mode}: no owner brief is sent` };
      const recs = await sendDailyBrief(graph, { now });
      const n = (s: string) => recs.filter((r) => r.status === s).length;
      return { summary: { briefs: { sent: n("sent"), dryRun: n("dry_run"), blocked: n("blocked"), failed: n("failed") } } };
    },
  },
  owner_alerts: {
    window: "hourly",
    slot: (tz, now) => {
      const m = localMoment(tz, now);
      return `${m.date}T${String(m.hour).padStart(2, "0")}`;
    },
    run: async ({ graph, controls, now }) => {
      const mode = operatingMode(controls);
      if (mode !== "supervised" && mode !== "live") return { summary: {}, note: `${mode}: no owner alerts are sent` };
      // Most notices go out right after the customer message that caused them; this catches anything missed.
      const recs = [...(await notifyOwnerDecisions(graph, { now })), ...(await notifyOwnerAttention(graph, { now }))];
      const n = (s: string) => recs.filter((r) => r.status === s).length;
      return { summary: { briefs: { sent: n("sent"), dryRun: n("dry_run"), blocked: n("blocked"), failed: n("failed") } } };
    },
  },
};

async function evaluateJob(graph: BusinessGraph, controls: BusinessControls, job: Exclude<JobId, "initiative_scan">, now: Date): Promise<JobOutcome> {
  const businessId = graph.business.id;
  const def = JOBS[job];
  const slot = def.slot(graph.business.timezone, now);
  const out = (decision: JobOutcome["decision"], reason: string, summary?: JobSummary): JobOutcome => ({ businessId, job, slot, decision, reason, ...(summary ? { summary } : {}) });
  if (!slot) return out("skipped", `outside the window (${def.window})`);
  const mode = operatingMode(controls);
  if (mode === "paused") return out("skipped", "the business is paused — nothing outbound runs");
  try {
    // One runner per (business, job) across instances; a busy job is left to the run that holds it.
    return await withConversationLock(
      `bg:${businessId}:${job}`,
      async () => {
        const prior = await loadJob(businessId, job, slot);
        if (prior?.status === "ran") return out("skipped", `slot ${slot} already ran`);
        if (prior?.status === "claimed" && now.getTime() - Date.parse(prior.claimedAt) < CLAIM_TTL_MS) return out("skipped", `slot ${slot} is being run`);
        if (prior?.status === "failed" && prior.attempts >= MAX_ATTEMPTS) return out("skipped", `slot ${slot} failed ${prior.attempts} times — not retried until the next slot`);
        const rec: JobRecord = { businessId, job, slot, status: "claimed", attempts: (prior?.attempts ?? 0) + 1, mode, claimedAt: now.toISOString() };
        await saveJob(rec);
        try {
          const { summary, note } = await def.run({ graph, controls, now });
          await saveJob({ ...rec, status: "ran", finishedAt: new Date().toISOString(), summary, ...(note ? { note } : {}) });
          return out("ran", note ?? "ran", summary);
        } catch (err) {
          const error = (err instanceof Error ? err.message : "failed").slice(0, 200);
          const retry = rec.attempts < MAX_ATTEMPTS;
          await saveJob({ ...rec, status: "failed", finishedAt: new Date().toISOString(), error, retry }).catch(() => undefined);
          console.error(`[barry:background] ${job} failed for ${businessId} (slot ${slot}, attempt ${rec.attempts}${retry ? ", will retry" : ", not retried"}): ${error}`);
          return out("failed", `${error}${retry ? " — retried on the next tick" : " — not retried this slot"}`);
        }
      },
      { waitMs: 0, ttlMs: CLAIM_TTL_MS }
    );
  } catch (err) {
    if (err instanceof ConversationBusyError) return out("skipped", "another run of this job is in progress");
    return out("failed", (err instanceof Error ? err.message : "failed").slice(0, 200));
  }
}

/** Every job for ONE business (a tick runs this per business). Demo businesses never run. */
export async function runBusinessJobs(graph: BusinessGraph, opts: { now?: Date; jobs?: JobId[] } = {}): Promise<JobOutcome[]> {
  const now = opts.now ?? new Date();
  const id = graph.business.id;
  const jobs = opts.jobs ?? ["followups", "owner_brief", "owner_alerts", "initiative_scan"];
  if (isDemoBusiness(id)) return [{ businessId: id, job: "followups", slot: null, decision: "skipped", reason: "demo business (never run)" }];
  let controls: BusinessControls;
  try {
    controls = await loadControls(id);
  } catch (err) {
    return [{ businessId: id, job: "followups", slot: null, decision: "failed", reason: `controls unavailable: ${err instanceof Error ? err.message : "error"}` }];
  }
  const outcomes: JobOutcome[] = [];
  for (const job of jobs) {
    if (job === "initiative_scan") {
      try {
        const t = await runInitiativeTick({ now, businessId: id });
        const o = t.outcomes[0];
        outcomes.push({ businessId: id, job, slot: o?.slot ? `${o.localDate}:${o.slot}` : null, decision: o?.decision ?? "skipped", reason: o?.reason ?? "no outcome", summary: { initiative: o?.scanId ?? "" } });
      } catch (err) {
        outcomes.push({ businessId: id, job, slot: null, decision: "failed", reason: (err instanceof Error ? err.message : "failed").slice(0, 200) });
      }
      continue;
    }
    outcomes.push(await evaluateJob(graph, controls, job, now));
  }
  return outcomes;
}

/**
 * One background tick: every fleet business (or only `businessId`), every job, one at a time; one failure
 * never stops the rest. The tick itself is recorded (fleet scope) with every outcome and why.
 */
export async function runBackgroundTick(opts: { now?: Date; businessId?: string; jobs?: JobId[] } = {}): Promise<BackgroundTick> {
  const now = opts.now ?? new Date();
  const jobs = opts.jobs ?? ["followups", "owner_brief", "owner_alerts", "initiative_scan"];
  const ids = (opts.businessId ? [opts.businessId] : fleetTenantIds()).filter((id, i, a) => a.indexOf(id) === i);
  const outcomes: JobOutcome[] = [];
  for (const id of ids) {
    const graph = fleetTenant(id);
    if (!graph) {
      outcomes.push({ businessId: id, job: "followups", slot: null, decision: "skipped", reason: "unknown business" });
      continue;
    }
    outcomes.push(...(await runBusinessJobs(graph, { now, jobs })));
  }
  const tick: BackgroundTick = { at: now.toISOString(), evaluated: ids.length, ran: outcomes.filter((o) => o.decision === "ran").length, skipped: outcomes.filter((o) => o.decision === "skipped").length, failed: outcomes.filter((o) => o.decision === "failed").length, outcomes };
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: "founder_state", key: `${TICK_PREFIX}${now.toISOString()}`, data: tick as unknown as Record<string, unknown> }).catch((err) => console.error("[barry:background] tick log failed", err instanceof Error ? err.message : err));
  if (tick.failed) console.error(`[barry:background] tick ${tick.at}: ${tick.failed} job(s) failed`, outcomes.filter((o) => o.decision === "failed"));
  return tick;
}
