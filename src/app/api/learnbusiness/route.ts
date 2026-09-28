import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerAuthError } from "@/lib/owner-auth";
import { getLearningWorkspace, runLearning } from "@/lib/learn-business/service";
import { graphOrNull, learnErrorResponse } from "@/lib/learn-business/http";

export async function GET(req: NextRequest) {
  const denied = ownerAuthError(req);
  if (denied) return denied;
  const graph = graphOrNull(req.nextUrl.searchParams.get("businessId"));
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  try {
    return Response.json(await getLearningWorkspace(graph));
  } catch (err) {
    return learnErrorResponse(err);
  }
}

const RunSchema = z.object({
  businessId: z.string().min(1),
  urls: z.array(z.string().max(2048)).min(1).max(8),
  /** The owner must explicitly approve fetching exactly these sources. */
  approved: z.literal(true),
  approvedBy: z.string().max(200).default("owner"),
});

export async function POST(req: NextRequest) {
  const denied = ownerAuthError(req);
  if (denied) return denied;
  const parsed = RunSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request: approve 1-8 source URLs" }, { status: 400 });
  const graph = graphOrNull(parsed.data.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  try {
    return Response.json(await runLearning({ graph, urls: parsed.data.urls, approvedBy: parsed.data.approvedBy }));
  } catch (err) {
    return learnErrorResponse(err);
  }
}
