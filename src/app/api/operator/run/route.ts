import { z } from "zod";
import { ownerAuthError } from "@/lib/owner-auth";
import { hqAuthError } from "@/lib/hq/auth";
import { fleetTenant } from "@/lib/hq/fleet";
import { runObligationExecutor } from "@/lib/operator/executor";
import { whatsappConfig, whatsappSender } from "@/lib/channels/whatsapp";

const Body = z.object({ businessId: z.string().min(1), confirm: z.literal(true), limit: z.number().int().min(1).max(25).optional() });

/**
 * One bounded pass of the proactive operator for a business. Owner session (that business) or founder.
 * Real sending happens only on WhatsApp conversations when the WhatsApp sender is configured LIVE;
 * everything else is a dry run that records what would have been sent.
 */
export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "businessId and confirm:true are required" }, { status: 400 });
  const founder = hqAuthError(req);
  if (founder) {
    const owner = ownerAuthError(req, parsed.data.businessId);
    if (owner) return owner;
  }
  const graph = fleetTenant(parsed.data.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  const wa = whatsappConfig();
  const run = await runObligationExecutor(graph, {
    limit: parsed.data.limit,
    senders: (c) => (c.id.startsWith("wa:") && wa.sendMode === "live" ? whatsappSender() : undefined),
  });
  return Response.json({ run });
}
