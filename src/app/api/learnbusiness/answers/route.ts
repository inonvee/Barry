import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerAuthError } from "@/lib/owner-auth";
import { answerOwnerQuestion, getLearningWorkspace } from "@/lib/learn-business/service";
import { graphOrNull, learnErrorResponse } from "@/lib/learn-business/http";

const AnswerSchema = z.object({
  businessId: z.string().min(1),
  key: z.string().min(1).max(64),
  value: z.string().min(1).max(1000),
  answeredBy: z.string().max(200).default("owner"),
});

export async function POST(req: NextRequest) {
  const parsed = AnswerSchema.safeParse(await req.json().catch(() => null));
  const denied = ownerAuthError(req, parsed.success ? parsed.data.businessId : undefined);
  if (denied) return denied;
  if (!parsed.success) return Response.json({ error: "Invalid answer" }, { status: 400 });
  const graph = graphOrNull(parsed.data.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  try {
    const fact = await answerOwnerQuestion(parsed.data);
    return Response.json({ fact, workspace: await getLearningWorkspace(graph) });
  } catch (err) {
    return learnErrorResponse(err);
  }
}
