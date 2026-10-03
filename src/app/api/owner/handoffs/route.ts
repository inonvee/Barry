import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { updateConversation } from "@/lib/state/update";
import { ConversationBusyError } from "@/lib/state/lock";
import { acknowledgeHandoff, resolveHandoff } from "@/lib/runtime/handoff";

const Body = z.object({ businessId: z.string().min(1), conversationId: z.string().min(1), handoffId: z.string().min(1), action: z.enum(["acknowledge", "resolve"]).default("resolve") });

/** The team closes a handoff. (Replying to the customer happens in the team's own channel today.) */
export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const g = ownerGraph(req, parsed.success ? parsed.data.businessId : undefined);
  if ("error" in g) return g.error;
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  try {
    // Under the conversation's lock, on its latest copy, version-checked: never overwrites a customer turn.
    type Outcome = { notFound: true } | { closed: true } | { handoff: NonNullable<ReturnType<typeof resolveHandoff>> };
    const done = await updateConversation<Outcome>(parsed.data.conversationId, (state) => {
      if (state.businessId !== g.graph.business.id) return { notFound: true };
      const resolved = parsed.data.action === "acknowledge" ? acknowledgeHandoff(state, parsed.data.handoffId, "owner") : resolveHandoff(state, parsed.data.handoffId, "owner");
      return resolved ? { handoff: resolved } : { closed: true };
    });
    if (!done || "notFound" in done.result) return Response.json({ error: "Conversation not found" }, { status: 404 });
    if ("closed" in done.result) return Response.json({ error: parsed.data.action === "acknowledge" ? "This handoff was already acknowledged or closed" : "This handoff is already closed" }, { status: 409 });
    return Response.json({ handoff: done.result.handoff });
  } catch (err) {
    if (err instanceof ConversationBusyError) return Response.json({ error: "BARRY is answering this customer right now — try again in a moment." }, { status: 409 });
    return ownerFailure("handoff", err);
  }
}
