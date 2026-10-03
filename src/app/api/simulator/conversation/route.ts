import { NextRequest, NextResponse } from "next/server";
import { getConversationForBusiness, getConversationStore } from "@/lib/state";
import { simulatorAccessError } from "@/lib/simulator-access";

/** A conversation is read only under its own business, by that business's owner: a foreign id reads as "no conversation". */
export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get("conversationId");
  const businessId = req.nextUrl.searchParams.get("businessId");
  const denied = simulatorAccessError(req, businessId);
  if (denied) return denied;
  if (!conversationId || !businessId) {
    return NextResponse.json({ error: "conversationId and businessId are required" }, { status: 400 });
  }
  const state = await getConversationForBusiness(getConversationStore(), conversationId, businessId);
  return NextResponse.json({ state: state ?? null });
}
