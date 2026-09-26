import { NextRequest, NextResponse } from "next/server";
import { getConversationStore } from "@/lib/state";

export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get("conversationId");
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }
  const state = getConversationStore().get(conversationId);
  return NextResponse.json({ state: state ?? null });
}
