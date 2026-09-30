import type { NextRequest } from "next/server";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { getTrainingProfile } from "@/lib/owner/training";

/** Train Barry: the onboarding profile (8 sections) and the paid-pilot readiness assessment. */
export async function GET(req: NextRequest) {
  const g = ownerGraph(req, req.nextUrl.searchParams.get("businessId"));
  if ("error" in g) return g.error;
  try {
    return Response.json(await getTrainingProfile(g.graph));
  } catch (err) {
    return ownerFailure("readiness", err);
  }
}
