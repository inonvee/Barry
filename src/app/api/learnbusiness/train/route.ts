import type { NextRequest } from "next/server";
import { ownerAuthError } from "@/lib/owner-auth";
import { graphOrNull, learnErrorResponse } from "@/lib/learn-business/http";
import { trainBarryView } from "@/lib/learn-business/train";

/** The Train BARRY view: understands / unsure / changed / needs confirmation / can do now / after setup / teach next. */
export async function GET(req: NextRequest) {
  const businessId = req.nextUrl.searchParams.get("businessId") ?? undefined;
  const denied = ownerAuthError(req, businessId);
  if (denied) return denied;
  const graph = graphOrNull(businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  try {
    return Response.json(await trainBarryView(graph));
  } catch (err) {
    return learnErrorResponse(err);
  }
}
