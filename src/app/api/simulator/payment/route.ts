import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getBusinessGraph } from "@/lib/fixtures";
import { handlePaymentOutcome } from "@/lib/runtime";
import { ConversationScopeError } from "@/lib/state";
import { SimulatedPaymentRefusedError } from "@/lib/payments/simulated";
import { simulatorAccessError, simulatorEnabled } from "@/lib/simulator-access";

const BodySchema = z.object({
  businessId: z.string(),
  conversationId: z.string(),
  paymentRequestId: z.string(),
  outcome: z.enum(["paid", "failed"]),
});

/**
 * Settle a TEST payment (simulated provider only) — the owner's simulator tool. A real provider's payment is
 * refused by the store itself: it changes only through that provider's verified webhook or status lookup.
 */
export async function POST(req: NextRequest) {
  if (!simulatorEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const { businessId, conversationId, paymentRequestId, outcome } = parsed.data;
  const denied = simulatorAccessError(req, businessId);
  if (denied) return denied;
  let graph;
  try {
    graph = getBusinessGraph(businessId);
  } catch {
    return NextResponse.json({ error: `Unknown business: ${businessId}` }, { status: 404 });
  }
  try {
    const result = await handlePaymentOutcome(graph, conversationId, paymentRequestId, outcome);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ConversationScopeError) return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof SimulatedPaymentRefusedError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
}
