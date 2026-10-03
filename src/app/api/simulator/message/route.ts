import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getBusinessGraph } from "@/lib/fixtures";
import { handleCustomerMessage } from "@/lib/runtime";
import { ConversationScopeError } from "@/lib/state";
import { notifyOwnerDecisions } from "@/lib/owner/briefs";
import { simulatorAccessError, simulatorEnabled } from "@/lib/simulator-access";

const BodySchema = z.object({
  businessId: z.string(),
  conversationId: z.string(),
  customerId: z.string(),
  message: z.string().min(1),
});

export async function POST(req: NextRequest) {
  if (!simulatorEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const { businessId, conversationId, customerId, message } = parsed.data;
  // Speaking as a customer is the owner's test tool, never a public endpoint.
  const denied = simulatorAccessError(req, businessId);
  if (denied) return denied;

  let graph;
  try {
    graph = getBusinessGraph(businessId);
  } catch {
    return NextResponse.json({ error: `Unknown business: ${businessId}` }, { status: 404 });
  }

  try {
    const outcome = await handleCustomerMessage(graph, conversationId, customerId, message);
    // A request for the owner is announced once on the owner line (no-op without a linked owner).
    await notifyOwnerDecisions(graph).catch((err) => console.warn("[barry:owner-brief] decision notice failed", err instanceof Error ? err.message : err));
    return NextResponse.json(outcome);
  } catch (err) {
    // A conversation id that belongs to another business is never continued under this one.
    if (err instanceof ConversationScopeError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
