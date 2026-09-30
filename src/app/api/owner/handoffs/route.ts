import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { getConversationStore } from "@/lib/state";
import { acknowledgeHandoff, resolveHandoff } from "@/lib/runtime/handoff";

const Body = z.object({ businessId: z.string().min(1), conversationId: z.string().min(1), handoffId: z.string().min(1), action: z.enum(["acknowledge", "resolve"]).default("resolve") });

/** The team closes a handoff. (Replying to the customer happens in the team's own channel today.) */
export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const g = ownerGraph(req, parsed.success ? parsed.data.businessId : undefined);
  if ("error" in g) return g.error;
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  try {
    const store = getConversationStore();
    const state = await store.get(parsed.data.conversationId);
    if (!state || state.businessId !== g.graph.business.id) return Response.json({ error: "Conversation not found" }, { status: 404 });
    const resolved = parsed.data.action === "acknowledge" ? acknowledgeHandoff(state, parsed.data.handoffId, "owner") : resolveHandoff(state, parsed.data.handoffId, "owner");
    if (!resolved) return Response.json({ error: parsed.data.action === "acknowledge" ? "This handoff was already acknowledged or closed" : "This handoff is already closed" }, { status: 409 });
    await store.save(state);
    return Response.json({ handoff: resolved });
  } catch (err) {
    return ownerFailure("handoff", err);
  }
}
