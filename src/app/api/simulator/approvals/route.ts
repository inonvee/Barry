import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getBusinessGraph } from "@/lib/fixtures";
import { resumeAfterApproval } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { withLifecycle } from "@/lib/runtime/owner-requests";
import { simulatorAccessError, simulatorEnabled } from "@/lib/simulator-access";

/** Listing and deciding requests from the simulator needs that business's owner session (and the simulator surface). */
const guard = (req: NextRequest, businessId: string) => simulatorAccessError(req, businessId);

export async function GET(req: NextRequest) {
  const businessId = req.nextUrl.searchParams.get("businessId");
  if (!simulatorEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
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
  if (!simulatorEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
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
