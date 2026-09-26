import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getBusinessGraph } from "@/lib/fixtures";
import { handlePaymentOutcome } from "@/lib/runtime";

const BodySchema = z.object({
  businessId: z.string(),
  conversationId: z.string(),
  paymentRequestId: z.string(),
  outcome: z.enum(["paid", "failed"]),
});

export async function POST(req: NextRequest) {
  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const { businessId, conversationId, paymentRequestId, outcome } = parsed.data;
  const graph = getBusinessGraph(businessId);
  const result = await handlePaymentOutcome(graph, conversationId, paymentRequestId, outcome);
  return NextResponse.json(result);
}
