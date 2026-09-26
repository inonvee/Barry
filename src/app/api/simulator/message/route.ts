import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getBusinessGraph } from "@/lib/fixtures";
import { handleCustomerMessage } from "@/lib/runtime";

const BodySchema = z.object({
  businessId: z.string(),
  conversationId: z.string(),
  customerId: z.string(),
  message: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const { businessId, conversationId, customerId, message } = parsed.data;

  let graph;
  try {
    graph = getBusinessGraph(businessId);
  } catch {
    return NextResponse.json({ error: `Unknown business: ${businessId}` }, { status: 404 });
  }

  const outcome = await handleCustomerMessage(graph, conversationId, customerId, message);
  return NextResponse.json(outcome);
}
