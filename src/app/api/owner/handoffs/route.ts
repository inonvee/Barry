import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { updateConversation } from "@/lib/state/update";
import { ConversationBusyError } from "@/lib/state/lock";
import { acknowledgeHandoff, resolveHandoff } from "@/lib/runtime/handoff";
import { OwnerControlError, ownerReply, ownerReturnToBarry, ownerTakeOver } from "@/lib/owner/human-control";

const Body = z.object({
  businessId: z.string().min(1),
  conversationId: z.string().min(1),
  handoffId: z.string().min(1).optional(),
  action: z.enum(["acknowledge", "resolve", "take_over", "reply", "resume"]).default("resolve"),
  text: z.string().max(4000).optional(),
  requestId: z.string().min(1).max(100).optional(),
});

const BY = "owner (web)";

/**
 * The team and a conversation BARRY handed over (or the owner took): acknowledge / resolve the handoff, take
 * the conversation, reply to the customer through BARRY's channel, give it back to BARRY. Same service as
 * every other owner surface (lib/owner/human-control).
 */
export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const g = ownerGraph(req, parsed.success ? parsed.data.businessId : undefined);
  if ("error" in g) return g.error;
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { action, conversationId, handoffId } = parsed.data;
  try {
    if (action === "take_over") return Response.json({ control: await ownerTakeOver(g.graph, conversationId, BY) });
    if (action === "resume") return Response.json({ control: await ownerReturnToBarry(g.graph, conversationId, BY) });
    if (action === "reply") {
      if (!parsed.data.requestId) return Response.json({ error: "Invalid request" }, { status: 400 });
      const reply = await ownerReply(g.graph, conversationId, { requestId: parsed.data.requestId, text: parsed.data.text ?? "", by: BY });
      const status = reply.status === "failed" ? 502 : reply.status === "unknown" ? 409 : 200;
      return Response.json({ reply }, { status });
    }
    if (!handoffId) return Response.json({ error: "Invalid request" }, { status: 400 });
    // Under the conversation's lock, on its latest copy, version-checked: never overwrites a customer turn.
    type Outcome = { notFound: true } | { closed: true } | { handoff: NonNullable<ReturnType<typeof resolveHandoff>> };
    const done = await updateConversation<Outcome>(conversationId, (state) => {
      if (state.businessId !== g.graph.business.id) return { notFound: true };
      const resolved = action === "acknowledge" ? acknowledgeHandoff(state, handoffId, "owner") : resolveHandoff(state, handoffId, "owner");
      return resolved ? { handoff: resolved } : { closed: true };
    });
    if (!done || "notFound" in done.result) return Response.json({ error: "Conversation not found" }, { status: 404 });
    if ("closed" in done.result) return Response.json({ error: action === "acknowledge" ? "This handoff was already acknowledged or closed" : "This handoff is already closed" }, { status: 409 });
    return Response.json({ handoff: done.result.handoff });
  } catch (err) {
    if (err instanceof OwnerControlError) return Response.json({ error: err.message, code: err.code }, { status: err.code === "not_found" ? 404 : err.code === "empty" ? 400 : 409 });
    if (err instanceof ConversationBusyError) return Response.json({ error: "BARRY is answering this customer right now — try again in a moment." }, { status: 409 });
    return ownerFailure("handoff", err);
  }
}
