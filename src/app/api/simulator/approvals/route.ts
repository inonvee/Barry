import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getBusinessGraph } from "@/lib/fixtures";
import { resumeAfterApproval } from "@/lib/runtime";
import { getBackend } from "@/lib/store/memory-backend";

export async function GET(req: NextRequest) {
  const businessId = req.nextUrl.searchParams.get("businessId");
  if (!businessId) return NextResponse.json({ error: "businessId is required" }, { status: 400 });
  const approvals = await getBackend().listApprovals(businessId);
  return NextResponse.json({ approvals });
}

const BodySchema = z.object({
  businessId: z.string(),
  approvalId: z.string(),
  decision: z.enum(["approved", "declined"]),
  decidedBy: z.string().default("owner"),
  alternateValue: z.unknown().optional(),
});

export async function POST(req: NextRequest) {
  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const { businessId, approvalId, decision, decidedBy, alternateValue } = parsed.data;
  const graph = getBusinessGraph(businessId);
  const result = await resumeAfterApproval(graph, approvalId, decision, decidedBy, alternateValue);
  return NextResponse.json(result);
}
