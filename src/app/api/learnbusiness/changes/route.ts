import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerAuthError } from "@/lib/owner-auth";
import { graphOrNull, learnErrorResponse } from "@/lib/learn-business/http";
import { decideLearningChange } from "@/lib/learn-business/relearn";
import { trainBarryView } from "@/lib/learn-business/train";

const Body = z.object({ businessId: z.string().min(1), changeId: z.string().min(1), decision: z.enum(["accepted", "kept_previous"]), by: z.string().max(200).default("owner") });

/** The owner decides a pending consequential change (accept the source's value, or keep theirs). */
export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const denied = ownerAuthError(req, parsed.success ? parsed.data.businessId : undefined);
  if (denied) return denied;
  if (!parsed.success) return Response.json({ error: "Invalid decision" }, { status: 400 });
  const graph = graphOrNull(parsed.data.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  try {
    const change = await decideLearningChange(parsed.data);
    return Response.json({ change, train: await trainBarryView(graph) });
  } catch (err) {
    return learnErrorResponse(err);
  }
}
