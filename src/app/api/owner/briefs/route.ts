import { z } from "zod";
import { ownerAuthError } from "@/lib/owner-auth";
import { hqAuthError } from "@/lib/hq/auth";
import { fleetTenant } from "@/lib/hq/fleet";
import { listBriefs, notifyFinishedOperations, notifyOwnerDecisions, sendDailyBrief } from "@/lib/owner/briefs";

const Body = z.object({ businessId: z.string().min(1), kind: z.enum(["decisions", "operations", "daily", "all"]).default("all") });

/**
 * Run the proactive owner briefs for one business (owner session or founder; a scheduler can call it).
 * Deduplicated per record key; outside WhatsApp's 24-hour window nothing is sent and the blocker is recorded.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "businessId is required" }, { status: 400 });
  if (hqAuthError(req)) {
    const owner = ownerAuthError(req, parsed.data.businessId);
    if (owner) return owner;
  }
  const graph = fleetTenant(parsed.data.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  const k = parsed.data.kind;
  const out = [
    ...(k === "decisions" || k === "all" ? await notifyOwnerDecisions(graph) : []),
    ...(k === "operations" || k === "all" ? await notifyFinishedOperations(graph) : []),
    ...(k === "daily" || k === "all" ? await sendDailyBrief(graph) : []),
  ];
  return Response.json({ briefs: out, recent: (await listBriefs(graph.business.id)).slice(0, 20) });
}
