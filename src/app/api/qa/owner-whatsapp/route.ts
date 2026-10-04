import { z } from "zod";
import { hqAuthError } from "@/lib/hq/auth";
import { ConversationBusyError, withConversationLock } from "@/lib/state/lock";
import { acceptanceCredentials, previewAcceptanceRefusal, routedPhoneNumberId } from "@/lib/qa/preview-acceptance-guard";
import { ACCEPTANCE_BUSINESS } from "../acceptance/runner";
import { OWA_STAGES, cleanupOwnerWhatsappRun, loadOwnerWhatsappReport, runOwnerWhatsappAcceptance } from "./runner";

/**
 * TEMPORARY QA SURFACE — the Owner WhatsApp V1 acceptance, run inside the Preview deployment.
 *
 *   POST /api/qa/owner-whatsapp                       run every stage (or { "stages": ["identity", …] })
 *   POST /api/qa/owner-whatsapp { "cleanup": runId }  delete that run's synthetic conversations (report kept)
 *   GET  /api/qa/owner-whatsapp?runId=…               the stored report of a run
 *
 * Exactly the guards of /api/qa/acceptance: exists only on a Vercel Preview on the Preview database with WhatsApp
 * explicitly dry_run (otherwise 404, Production included); founder-authenticated (bearer token or HQ session);
 * one acceptance run at a time (the same lock as the channel acceptance). Responses carry statuses, ids, counts
 * and short reply texts only — never a secret value.
 */
export const maxDuration = 300;

const NOT_FOUND = () => new Response("Not found", { status: 404 });
const RUN_ID = /^owa-\d+$/;
const Body = z.object({ stages: z.array(z.enum(OWA_STAGES)).min(1).optional(), cleanup: z.string().regex(RUN_ID).optional() }).strict();

function gate(req: Request): Response | undefined {
  if (previewAcceptanceRefusal()) return NOT_FOUND();
  return hqAuthError(req);
}

export async function GET(req: Request) {
  const denied = gate(req);
  if (denied) return denied;
  const runId = new URL(req.url).searchParams.get("runId") ?? "";
  if (!RUN_ID.test(runId)) return Response.json({ error: "runId is required" }, { status: 400 });
  const report = await loadOwnerWhatsappReport(runId);
  return report ? Response.json(report) : Response.json({ error: "No such run" }, { status: 404 });
}

export async function POST(req: Request) {
  const denied = gate(req);
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "Body: { stages?: string[] } or { cleanup: runId }", stages: OWA_STAGES }, { status: 400 });
  if (parsed.data.cleanup) return Response.json({ runId: parsed.data.cleanup, conversationsDeleted: await cleanupOwnerWhatsappRun(parsed.data.cleanup) });
  const creds = acceptanceCredentials(ACCEPTANCE_BUSINESS);
  if (!creds.ok) return Response.json({ error: "The deployment is missing what the acceptance needs", missing: creds.missing }, { status: 412 });
  const phoneNumberId = routedPhoneNumberId(ACCEPTANCE_BUSINESS);
  if (!phoneNumberId) return Response.json({ error: `No WhatsApp test number is routed to ${ACCEPTANCE_BUSINESS} (BARRY_WHATSAPP_ROUTES)` }, { status: 412 });
  const runId = `owa-${Date.now()}`;
  try {
    const report = await withConversationLock(`qa-acceptance:${ACCEPTANCE_BUSINESS}`, () => runOwnerWhatsappAcceptance({ appSecret: creds.appSecret }, { phoneNumberId, stages: parsed.data.stages ?? [...OWA_STAGES], runId }), { waitMs: 0, ttlMs: 330_000 });
    return Response.json(report, { status: report.verdict === "PASS" ? 200 : 422 });
  } catch (err) {
    if (err instanceof ConversationBusyError) return Response.json({ error: "Another acceptance run is in progress" }, { status: 409 });
    console.error("[barry:qa-owner-whatsapp] run failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    return Response.json({ runId, error: "The acceptance run failed before producing a report — see GET ?runId=" }, { status: 500 });
  }
}
