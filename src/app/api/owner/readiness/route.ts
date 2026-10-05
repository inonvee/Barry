import type { NextRequest } from "next/server";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { getTrainingProfile } from "@/lib/owner/training";
import { launchChecklist, ownerDesignPartnerView } from "@/lib/hq/launch";
import { loadControls } from "@/lib/hq/controls";

/** Train Barry: the onboarding profile (8 sections), the paid-pilot readiness assessment and the Design Partner verdict. */
export async function GET(req: NextRequest) {
  const g = ownerGraph(req, req.nextUrl.searchParams.get("businessId"));
  if ("error" in g) return g.error;
  try {
    const [profile, gate] = await Promise.all([getTrainingProfile(g.graph), loadControls(g.graph.business.id).then((controls) => launchChecklist(g.graph, { controls }))]);
    // The Design Partner verdict (READY FOR SUPERVISED / BLOCKED) with each blocker in plain words — the same gate the founder sees.
    return Response.json({ ...profile, designPartner: ownerDesignPartnerView(gate) });
  } catch (err) {
    return ownerFailure("readiness", err);
  }
}
