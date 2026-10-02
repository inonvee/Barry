import type { NextRequest } from "next/server";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { getOwnerConversation } from "@/lib/owner/conversation";

/** One conversation as the owner sees it (advanced=1 adds a technical summary of each turn). */
export async function GET(req: NextRequest) {
  const g = ownerGraph(req, req.nextUrl.searchParams.get("businessId"));
  if ("error" in g) return g.error;
  const id = req.nextUrl.searchParams.get("conversationId");
  if (!id) return Response.json({ error: "conversationId is required" }, { status: 400 });
  try {
    const view = await getOwnerConversation(g.graph, id, req.nextUrl.searchParams.get("advanced") === "1", req.nextUrl.searchParams.get("lang") === "he" ? "he" : "en");
    return view ? Response.json(view) : Response.json({ error: "Conversation not found" }, { status: 404 });
  } catch (err) {
    return ownerFailure("conversation", err);
  }
}
