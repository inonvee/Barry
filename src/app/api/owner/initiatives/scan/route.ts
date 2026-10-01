import { z } from "zod";
import { ownerAuthError } from "@/lib/owner-auth";
import { hqAuthError } from "@/lib/hq/auth";
import { fleetTenant } from "@/lib/hq/fleet";
import { runInitiativeScan } from "@/lib/initiative/engine";

const Body = z.object({ businessId: z.string().min(1), trigger: z.enum(["scheduled", "manual"]).default("manual"), force: z.boolean().optional() });

/**
 * One bounded initiative scan for one business (owner session or founder) — ready for a scheduler to
 * call 2–3 times a business-local day. Over the daily limit it records a skipped scan and does nothing.
 * Scans never send anything.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "businessId is required" }, { status: 400 });
  const founder = !hqAuthError(req);
  if (!founder) {
    const owner = ownerAuthError(req, parsed.data.businessId);
    if (owner) return owner;
  }
  const graph = fleetTenant(parsed.data.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  // Only the founder may bypass the daily scan limit (QA / diagnosis); owners and schedulers can't.
  const { scan, initiatives } = await runInitiativeScan(graph, { trigger: parsed.data.trigger, force: founder && parsed.data.force === true });
  return Response.json({ scan, surfaced: initiatives.filter((i) => ["surfaced", "reviewed", "accepted", "acting"].includes(i.state)).length });
}
