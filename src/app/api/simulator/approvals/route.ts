import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getBusinessGraph } from "@/lib/fixtures";
import { resumeAfterApproval } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { ownerAccessConfigured, ownerAuthError } from "@/lib/owner-auth";

/** Once owner access is configured, deciding (and listing) requests needs that business's owner session. */
function guard(req: NextRequest, businessId: string): Response | undefined {
  return ownerAccessConfigured() ? ownerAuthError(req, businessId) : undefined;
}

export async function GET(req: NextRequest) {
  const businessId = req.nextUrl.searchParams.get("businessId");
  if (!businessId) return NextResponse.json({ error: "businessId is required" }, { status: 400 });
  const denied = guard(req, businessId);
  if (denied) return denied;
  const raw = await getBackend().listApprovals(businessId);
  // The authoritative lifecycle (active / superseded / withdrawn / declined / executed / failed), not just the stored status.
  const store = getConversationStore();
  const ids = [...new Set(raw.map((a) => a.conversationId))];
  const states = new Map(await Promise.all(ids.map(async (id) => [id, await store.get(id).catch(() => undefined)] as const)));
  const approvals = withLifecycle(raw, states);
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
  const denied = guard(req, businessId);
  if (denied) return denied;
  // A request is decided only under its own business.
  const approval = await getBackend().getApproval(approvalId);
  if (!approval || approval.businessId !== businessId) return NextResponse.json({ error: "Request not found" }, { status: 404 });
  const graph = getBusinessGraph(businessId);
  const result = await resumeAfterApproval(graph, approvalId, decision, decidedBy, alternateValue);
  return NextResponse.json(result);
}
