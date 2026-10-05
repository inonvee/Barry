import { z } from "zod";
import { hqAuthError } from "@/lib/hq/auth";
import { ConversationBusyError, withConversationLock } from "@/lib/state/lock";
import { acceptanceCredentials, previewAcceptanceRefusal, routedPhoneNumberId } from "@/lib/qa/preview-acceptance-guard";
import { readRestorePoint, restoreFromPoint } from "@/lib/qa/restore-point";
import { loadControls } from "@/lib/hq/controls";
import { ACCEPTANCE_BUSINESS } from "../acceptance/runner";
import { ODP_STAGES, cleanupOwnerDesignPartnerRun, loadOwnerDesignPartnerReport, runOwnerDesignPartnerAcceptance } from "./runner";

/**
 * TEMPORARY QA SURFACE — the Owner Design Partner readiness acceptance, run inside the Preview deployment.
 *
 *   POST /api/qa/owner-design-partner { "stages": ["identity"] }  run stages (the QA page runs ONE stage per request)
 *   POST /api/qa/owner-design-partner { "restore": true }         put the test business back from its restore point
 *   POST /api/qa/owner-design-partner { "cleanup": runId }        delete any synthetic conversation of that run still left
 *   GET  /api/qa/owner-design-partner?runId=…                     the stored report of a run
 *   GET  /api/qa/owner-design-partner?state=1                     the test business's controls + pending restore point
 *
 * Every stage deletes its own synthetic conversations and revokes every synthetic identity before it answers.
 *
 * Exactly the guards of /api/qa/acceptance: exists only on a Vercel Preview on the Preview database with WhatsApp
 * explicitly dry_run (otherwise 404, Production included); founder-authenticated (bearer token or HQ session);
 * one acceptance run at a time. A run that approaches the function limit stops itself and restores; a run that is
 * killed anyway leaves a durable restore point that the next request (or { restore: true }) applies.
 * Responses carry statuses, ids, counts and short reply texts only — never a secret value.
 */
export const maxDuration = 300;

const NOT_FOUND = () => new Response("Not found", { status: 404 });
const RUN_ID = /^odp-\d+$/;
const LOCK = `qa-acceptance:${ACCEPTANCE_BUSINESS}`;
/** The lease outlives no function: a killed run's lock frees itself by Vercel's own limit. */
const LOCK_TTL_MS = 300_000;
/** If the run is still going this close to the limit, answer (restored) instead of being killed silently. */
const HARD_STOP_MS = 280_000;
const Body = z.object({ stages: z.array(z.enum(ODP_STAGES)).min(1).optional(), cleanup: z.string().regex(RUN_ID).optional(), restore: z.literal(true).optional() }).strict();
const BY = "founder (qa owner-design-partner restore)";

function gate(req: Request): Response | undefined {
  if (previewAcceptanceRefusal()) return NOT_FOUND();
  return hqAuthError(req);
}

async function businessState() {
  const c = await loadControls(ACCEPTANCE_BUSINESS);
  const point = await readRestorePoint(ACCEPTANCE_BUSINESS);
  return { businessId: ACCEPTANCE_BUSINESS, mode: c.mode, pausedBusiness: c.pausedBusiness, pausedBy: c.pausedBy, restorePoint: point ? { mode: point.mode, pausedBusiness: point.pausedBusiness, createdAt: point.createdAt } : null };
}

export async function GET(req: Request) {
  const denied = gate(req);
  if (denied) return denied;
  const url = new URL(req.url);
  if (url.searchParams.get("state")) return Response.json(await businessState());
  const runId = url.searchParams.get("runId") ?? "";
  if (!RUN_ID.test(runId)) return Response.json({ error: "runId is required" }, { status: 400 });
  const report = await loadOwnerDesignPartnerReport(runId);
  return report ? Response.json(report) : Response.json({ error: "No such run" }, { status: 404 });
}

export async function POST(req: Request) {
  const denied = gate(req);
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "Body: { stages?: string[] } | { restore: true } | { cleanup: runId }", stages: ODP_STAGES }, { status: 400 });
  // Each stage already deleted its synthetic conversations; this repeats it (idempotent) for the QA page's button.
  if (parsed.data.cleanup) return Response.json({ runId: parsed.data.cleanup, conversationsDeleted: await cleanupOwnerDesignPartnerRun(parsed.data.cleanup) });
  if (parsed.data.restore) {
    // Never under a running stage: it restores itself; a killed one's lease expires and then this applies.
    try {
      const result = await withConversationLock(LOCK, () => restoreFromPoint(ACCEPTANCE_BUSINESS, BY, "owner-design-partner acceptance: restore requested from the QA page"), { waitMs: 0, ttlMs: 60_000 });
      return Response.json({ ...result, state: await businessState() }, { status: result.restored ? 200 : 500 });
    } catch (err) {
      if (err instanceof ConversationBusyError) return Response.json({ busy: true, error: "A stage still holds the acceptance lock (it restores itself when it ends; a killed one's lock frees within 5 minutes)", state: await businessState() }, { status: 409 });
      throw err;
    }
  }
  const creds = acceptanceCredentials(ACCEPTANCE_BUSINESS);
  if (!creds.ok) return Response.json({ error: "The deployment is missing what the acceptance needs", missing: creds.missing }, { status: 412 });
  const phoneNumberId = routedPhoneNumberId(ACCEPTANCE_BUSINESS);
  if (!phoneNumberId) return Response.json({ error: `No WhatsApp test number is routed to ${ACCEPTANCE_BUSINESS} (BARRY_WHATSAPP_ROUTES)` }, { status: 412 });
  const runId = `odp-${Date.now()}`;
  const stages = parsed.data.stages ?? [...ODP_STAGES];
  try {
    const run = withConversationLock(LOCK, () => runOwnerDesignPartnerAcceptance({ appSecret: creds.appSecret, ownerToken: creds.ownerToken }, { phoneNumberId, stages, runId }), { waitMs: 0, ttlMs: LOCK_TTL_MS });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hardStop = new Promise<"hard_stop">((r) => (timer = setTimeout(() => r("hard_stop"), HARD_STOP_MS)));
    const report = await Promise.race([run, hardStop]).finally(() => clearTimeout(timer));
    if (report === "hard_stop") {
      // The run did not stop at its budget (a step hung). Its later steps refuse to run (past the budget); put the
      // business back now rather than risk being killed with it changed.
      run.catch(() => undefined);
      const restore = await restoreFromPoint(ACCEPTANCE_BUSINESS, BY, `owner-design-partner acceptance ${runId}: hard stop before the function limit`).catch((e) => ({ restored: false, error: e instanceof Error ? e.message : "failed" }));
      return Response.json({ runId, stages, timedOut: true, verdict: "FAIL", error: `Stage did not finish within ${HARD_STOP_MS / 1000}s; stopped and restored before Vercel's 300s limit`, restore, state: await businessState() }, { status: 504 });
    }
    return Response.json(report, { status: report.verdict === "PASS" ? 200 : 422 });
  } catch (err) {
    if (err instanceof ConversationBusyError) return Response.json({ error: "Another acceptance run is in progress", busy: true }, { status: 409 });
    console.error("[barry:qa-owner-design-partner] run failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    const restore = await restoreFromPoint(ACCEPTANCE_BUSINESS, BY, `owner-design-partner acceptance ${runId}: run failed before producing a report`).catch(() => undefined);
    return Response.json({ runId, error: "The acceptance run failed before producing a report — see GET ?runId=", restore }, { status: 500 });
  }
}
