import type { NextRequest } from "next/server";
import { ownerGraph } from "@/lib/owner/http";
import { ownerChannels } from "@/lib/owner/service";

/** The owner's channel state (customer WhatsApp routing, owner-command readiness). No secrets. */
export async function GET(req: NextRequest) {
  const g = ownerGraph(req, req.nextUrl.searchParams.get("businessId"));
  if ("error" in g) return g.error;
  return Response.json(ownerChannels(g.graph.business.id));
}
