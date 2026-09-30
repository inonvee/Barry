import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerAuthError } from "@/lib/owner-auth";
import { generateOperatingStrategy, getLearningWorkspace } from "@/lib/learn-business/service";
import { graphOrNull, learnErrorResponse } from "@/lib/learn-business/http";

export async function POST(req: NextRequest) {
  const parsed = z.object({ businessId: z.string().min(1) }).safeParse(await req.json().catch(() => null));
  const denied = ownerAuthError(req, parsed.success ? parsed.data.businessId : undefined);
  if (denied) return denied;
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const graph = graphOrNull(parsed.data.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  try {
    const strategy = await generateOperatingStrategy(graph);
    return Response.json({ strategy, workspace: await getLearningWorkspace(graph) });
  } catch (err) {
    return learnErrorResponse(err);
  }
}
