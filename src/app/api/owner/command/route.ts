import { z } from "zod";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { executeOwnerCommand } from "@/lib/owner/command-service";

const Body = z.object({ businessId: z.string().min(1), requestId: z.string().min(8).max(80), text: z.string().max(1000).optional(), actionId: z.string().max(260).optional() }).refine((b) => b.text?.trim() || b.actionId, "text or actionId is required");

/**
 * The web command bar → the SAME owner command service the WhatsApp owner channel uses. The owner's
 * signed-in session is the identity; `requestId` makes a retried request (double submit) idempotent.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const g = ownerGraph(req, parsed.success ? parsed.data.businessId : undefined);
  if ("error" in g) return g.error;
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  try {
    const at = new Date().toISOString();
    const result = await executeOwnerCommand({ graph: g.graph, source: "web", actor: { kind: "web" }, key: `web:${parsed.data.requestId}`, ...(parsed.data.text ? { text: parsed.data.text } : {}), ...(parsed.data.actionId ? { actionId: parsed.data.actionId } : {}), trace: [{ step: "identity", outcome: "ok", detail: "signed-in owner session for this business", at }] });
    return Response.json({ reply: result.reply, commandId: result.record.id, duplicate: result.duplicate });
  } catch (err) {
    return ownerFailure("command", err);
  }
}
