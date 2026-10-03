import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { ConversationBusyError, withConversationLock } from "@/lib/state/lock";
import { resumeAfterApproval } from "@/lib/runtime";
import { revalidateUnresolvedTurns } from "@/lib/runtime/engine";
import { revalidatedChangeText } from "@/lib/reasoner/deterministic-compose";
import { SCRATCH_KEYS } from "@/lib/runtime/compiler";

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
      // Re-check under the conversation's lock, on its latest copy (version-checked save).
      return await withConversationLock(approval.conversationId, async () => {
        const state = await getConversationStore().get(approval.conversationId);
        if (!state) return Response.json({ error: "Conversation not found" }, { status: 404 });
        const result = await revalidateUnresolvedTurns(g.graph, state);
        // The customer hears what became of their earlier message (the old request, and the corrected one).
        if (result.changedRequests > 0) state.messages.push({ role: "barry", content: revalidatedChangeText(state.knownFields[SCRATCH_KEYS.conversationLanguage], result.recovered.find((x) => x.outcome !== "unrelated")), at: new Date().toISOString() });
        await getConversationStore().save(state);
        return Response.json({ recheck: result });
      });
    }
    const outcome = await resumeAfterApproval(g.graph, approvalId, action === "approve" ? "approved" : "declined", "owner");
    return Response.json({ result: outcome.turn.trace?.stop.reason ?? outcome.turn.understood.intent, message: outcome.response, held: outcome.turn.trace?.hold ?? null });
  } catch (err) {
    if (err instanceof ConversationBusyError) return Response.json({ error: "BARRY is answering this customer right now — try again in a moment." }, { status: 409 });
    return ownerFailure("approval", err);
  }
}
