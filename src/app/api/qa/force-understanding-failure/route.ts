import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerAuthError } from "@/lib/owner-auth";
import { qaEnabled, QA_FORCE_UNDERSTANDING_FAILURE } from "@/lib/qa/mode";
import { ConversationScopeError, getConversationStore } from "@/lib/state";
import { graphOrNull } from "@/lib/learn-business/http";

/**
 * QA ONLY: the next customer message in this conversation fails understanding (one shot), so the runtime
 * after a failed understanding can be tested (held approvals, revalidation). Never available on Vercel
 * Production; gated by owner access to the business.
 */
const Body = z.object({ businessId: z.string().min(1), conversationId: z.string().min(1), active: z.boolean().default(true) });

export async function POST(req: NextRequest) {
  if (!qaEnabled()) return new Response("Not found", { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const denied = ownerAuthError(req, parsed.success ? parsed.data.businessId : undefined);
  if (denied) return denied;
  if (!parsed.success) return Response.json({ error: "businessId and conversationId are required" }, { status: 400 });
  const graph = graphOrNull(parsed.data.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  const store = getConversationStore();
  const state = await store.getOrCreate(parsed.data.conversationId, graph.business.id, "qa-customer").catch((err) => {
    if (err instanceof ConversationScopeError) return undefined;
    throw err;
  });
  if (!state) return Response.json({ error: "Conversation not found" }, { status: 404 });
  if (parsed.data.active) state.knownFields[QA_FORCE_UNDERSTANDING_FAILURE] = "1";
  else delete state.knownFields[QA_FORCE_UNDERSTANDING_FAILURE];
  await store.save(state);
  return Response.json({ armed: parsed.data.active, conversationId: state.id, note: parsed.data.active ? "The NEXT customer message in this conversation will fail understanding (qa_forced_understanding_failure). One shot." : "Disarmed." });
}
