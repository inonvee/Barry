import type { NextRequest } from "next/server";
import { ownerAuthError } from "@/lib/owner-auth";
import { describeBusinessConnections } from "@/lib/connections/status";
import { resolveCapabilityProfiles } from "@/lib/capabilities";
import { graphOrNull } from "@/lib/learn-business/http";

export async function GET(req: NextRequest) {
  const denied = ownerAuthError(req);
  if (denied) return denied;
  const graph = graphOrNull(req.nextUrl.searchParams.get("businessId"));
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  try {
    return Response.json({ business: { id: graph.business.id, name: graph.business.name }, connections: await describeBusinessConnections(graph.business.id, await resolveCapabilityProfiles(graph)) });
  } catch (err) {
    console.error("[barry:connections]", err);
    return Response.json({ error: "Could not load connections" }, { status: 500 });
  }
}
