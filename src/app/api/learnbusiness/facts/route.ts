import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerAuthError } from "@/lib/owner-auth";
import { getLearningWorkspace, reviewLearnedFact } from "@/lib/learn-business/service";
import { graphOrNull, learnErrorResponse } from "@/lib/learn-business/http";

const ReviewSchema = z.object({
  businessId: z.string().min(1),
  factId: z.string().min(1),
  action: z.enum(["verify", "correct", "reject"]),
  value: z.string().max(500).optional(),
  reviewedBy: z.string().max(200).default("owner"),
});

export async function POST(req: NextRequest) {
  const denied = ownerAuthError(req);
  if (denied) return denied;
  const parsed = ReviewSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid review" }, { status: 400 });
  const graph = graphOrNull(parsed.data.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  try {
    const fact = await reviewLearnedFact(parsed.data);
    return Response.json({ fact, workspace: await getLearningWorkspace(graph) });
  } catch (err) {
    return learnErrorResponse(err);
  }
}
