import { z } from "zod";
import { hqAuthError } from "@/lib/hq/auth";
import { fleetTenant } from "@/lib/hq/fleet";
import { listCostEvidence, recordCostEvidence } from "@/lib/finance/evidence";
import { profitOpportunities } from "@/lib/finance/impact";

/** Founder-only: record normalized cost evidence for a business (from a connected system's export) and list it. */
export async function GET(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const businessId = new URL(req.url).searchParams.get("businessId") ?? "";
  const graph = fleetTenant(businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  const evidence = await listCostEvidence(graph.business.id);
  return Response.json({ evidence, opportunities: profitOpportunities(graph.business.id, evidence) });
}

const Body = z.object({ businessId: z.string().min(1), items: z.array(z.unknown()).min(1).max(500) });

export async function POST(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "businessId and 1–500 items are required" }, { status: 400 });
  const graph = fleetTenant(parsed.data.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  const result = await recordCostEvidence(graph.business.id, parsed.data.items);
  return Response.json(result);
}
