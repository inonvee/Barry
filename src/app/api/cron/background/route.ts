import { hqAuthError } from "@/lib/hq/auth";
import { cronAuthorized } from "@/lib/hq/cron-auth";
import { listBackgroundTicks, runBackgroundTick } from "@/lib/background/runner";

/**
 * Background tick (follow-ups, abandoned checkout, owner brief, initiative scans). Vercel Cron calls GET
 * hourly with `Authorization: Bearer $CRON_SECRET` (vercel.json); a founder session / token may also call it.
 * Every job decides from business-local time, its durable slot record and the business's operating mode —
 * a tick never forces anything. Founder-only for proof: `?businessId=` limits to one business, `?at=<ISO>`
 * evaluates another moment (slots, limits and the mode gate still apply).
 */
async function handle(req: Request) {
  // A cookie-only founder call must be a POST (a GET is reachable from a link on another site).
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
  const tick = await runBackgroundTick({ now, businessId });
  // Failures are visible to the caller (and logged): Vercel shows a non-2xx cron run as failed.
  return Response.json({ tick, recent: founder ? await listBackgroundTicks(5) : undefined }, { status: tick.failed ? 500 : 200 });
}

export const GET = handle;
export const POST = handle;
