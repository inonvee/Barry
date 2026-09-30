import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { resumeAfterApproval } from "@/lib/runtime";
import { revalidateUnresolvedTurns } from "@/lib/runtime/engine";

const Body = z.object({ businessId: z.string().min(1), approvalId: z.string().min(1), action: z.enum(["approve", "decline", "recheck"]) });

/**
 * The owner decides a request. Approving goes through the same path as everywhere: revalidation of
 * anything the customer said since, the intent hold, the final-write gate, compare-and-set resolution.
 * "recheck" re-interprets messages BARRY couldn't understand (no decision is made).
 */
export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const g = ownerGraph(req, parsed.success ? parsed.data.businessId : undefined);
  if ("error" in g) return g.error;
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { approvalId, action } = parsed.data;
  try {
    const approval = await getBackend().getApproval(approvalId);
    if (!approval || approval.businessId !== g.graph.business.id) return Response.json({ error: "Request not found" }, { status: 404 });
    if (action === "recheck") {
      const state = await getConversationStore().get(approval.conversationId);
      if (!state) return Response.json({ error: "Conversation not found" }, { status: 404 });
      const result = await revalidateUnresolvedTurns(g.graph, state);
      await getConversationStore().save(state);
      return Response.json({ recheck: result });
    }
    const outcome = await resumeAfterApproval(g.graph, approvalId, action === "approve" ? "approved" : "declined", "owner");
    return Response.json({ result: outcome.turn.trace?.stop.reason ?? outcome.turn.understood.intent, message: outcome.response, held: outcome.turn.trace?.hold ?? null });
  } catch (err) {
    return ownerFailure("approval", err);
  }
}
