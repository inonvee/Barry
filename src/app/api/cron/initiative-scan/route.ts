import { hqAuthError } from "@/lib/hq/auth";
import { cronAuthorized } from "@/lib/hq/cron-auth";
import { listTicks, runInitiativeTick } from "@/lib/initiative/scheduler";

/**
 * Scheduler tick for the Initiative Engine. Vercel Cron calls GET with `Authorization: Bearer $CRON_SECRET`
 * (see vercel.json, about hourly); a founder session / token may also call it. Unset CRON_SECRET → only the
 * founder can call it (never open). It scans only the businesses whose business-local slot is due, through
 * runInitiativeScan — never forced, nothing sent. Founder-only extras for proof: `?businessId=` limits the
 * tick to one business; `?at=<ISO>` evaluates another moment (slots and the engine's daily limit still apply).
 */
async function handle(req: Request) {
  // A cookie-only founder call must be a POST: a GET is reachable from a link on another site (Lax cookie),
  // so GET accepts only an Authorization header (the cron secret or the founder bearer token).
  const viaHeader = Boolean(req.headers.get("authorization"));
  const founder = (req.method !== "GET" || viaHeader) && !hqAuthError(req);
  if (!founder && !cronAuthorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  let now: Date | undefined;
  let businessId: string | undefined;
  if (founder) {
    const at = url.searchParams.get("at");
    if (at) {
      now = new Date(at);
      if (Number.isNaN(now.getTime())) return Response.json({ error: "Invalid at" }, { status: 400 });
    }
    businessId = url.searchParams.get("businessId") ?? undefined;
  }
  const tick = await runInitiativeTick({ now, businessId });
  return Response.json({ tick, recent: founder ? await listTicks(5) : undefined });
}

export const GET = handle;
export const POST = handle;
