import { hqAuthError } from "@/lib/hq/auth";
import { fleetTenant } from "@/lib/hq/fleet";
import { initiativeMetrics } from "@/lib/initiative/engine";
import { listInitiatives, listScans } from "@/lib/initiative/store";

/**
 * FOUNDER ONLY — initiative inspection for one business: every initiative (detector, category,
 * confidence, evidence references, lifecycle, decisions, measured result, internal rank), recent scans
 * (with rejected candidates and why), and quality metrics. Evidence is record ids — no message text.
 */
export async function GET(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const businessId = new URL(req.url).searchParams.get("businessId") ?? "";
  if (!fleetTenant(businessId)) return Response.json({ error: "Unknown business" }, { status: 404 });
  const [initiatives, scans, metrics] = await Promise.all([listInitiatives(businessId), listScans(businessId), initiativeMetrics(businessId)]);
  return Response.json({ initiatives, scans: scans.slice(0, 30), metrics });
}
