import type { NextRequest } from "next/server";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { getOwnerWorkspace, startOfLocalDay } from "@/lib/owner/service";
import { langFrom } from "@/lib/owner/lang";

const WINDOWS: Record<string, number> = { "7d": 7, "30d": 30 };

export async function GET(req: NextRequest) {
  const g = ownerGraph(req, req.nextUrl.searchParams.get("businessId"));
  if ("error" in g) return g.error;
  const w = req.nextUrl.searchParams.get("window") ?? "today";
  const days = WINDOWS[w];
  const since = days ? new Date(Date.parse(startOfLocalDay(g.graph.business.timezone)) - (days - 1) * 24 * 3600 * 1000).toISOString() : undefined;
  try {
    const lang = langFrom(req.nextUrl.searchParams.get("lang"));
    const label = days ? (lang === "he" ? `ב־${days} הימים האחרונים` : `last ${days} days`) : lang === "he" ? "היום" : "today";
    return Response.json(await getOwnerWorkspace(g.graph, { since, label, lang }));
  } catch (err) {
    return ownerFailure("workspace", err);
  }
}
