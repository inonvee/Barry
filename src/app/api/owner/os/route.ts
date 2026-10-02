import type { NextRequest } from "next/server";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { getOwnerOs } from "@/lib/owner/os-service";
import { langFrom } from "@/lib/owner/lang";

/** The Owner Business OS: rules BARRY follows, connected systems, BARRY setup, unanswered customer questions. Read-only. */
export async function GET(req: NextRequest) {
  const g = ownerGraph(req, req.nextUrl.searchParams.get("businessId"));
  if ("error" in g) return g.error;
  try {
    return Response.json(await getOwnerOs(g.graph, langFrom(req.nextUrl.searchParams.get("lang"))));
  } catch (err) {
    return ownerFailure("os", err);
  }
}
