import type { NextRequest } from "next/server";
import { ownerGraph } from "@/lib/owner/http";
import { ownerChannels } from "@/lib/owner/service";
import { linkActive, listOwnerIdentities, maskedIdentity } from "@/lib/owner-channel/identity";

/** The owner's channel state (customer WhatsApp routing, owner-command readiness). No secrets, numbers masked. */
export async function GET(req: NextRequest) {
  const g = ownerGraph(req, req.nextUrl.searchParams.get("businessId"));
  if ("error" in g) return g.error;
  const links = (await listOwnerIdentities(g.graph.business.id).catch(() => [])).filter((l) => linkActive(l).ok).map(maskedIdentity);
  return Response.json(ownerChannels(g.graph.business.id, links));
}
