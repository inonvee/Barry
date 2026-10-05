import { z } from "zod";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { createLinkCode, linkActive, listOwnerIdentities, maskedIdentity, revokeOwnerIdentity } from "@/lib/owner-channel/identity";
import { whatsappOwnerReach } from "@/lib/channels/whatsapp";
import { customerWhatsappState, setTeamRepliesInApp } from "@/lib/channels/business-numbers";

/**
 * The owner's own WhatsApp link (owner session for THIS business only): status, a one-time link code,
 * revoke. Numbers are shown masked; codes are shown once and stored only as a hash.
 */
export async function GET(req: Request) {
  const businessId = new URL(req.url).searchParams.get("businessId");
  const g = ownerGraph(req, businessId);
  if ("error" in g) return g.error;
  try {
    // A dedicated owner line OR the business's shared number (identity role routing) — either reaches Owner BARRY.
    const cfg = whatsappOwnerReach(g.graph.business.id);
    const links = (await listOwnerIdentities(g.graph.business.id)).map((l) => ({ id: l.id, number: maskedIdentity(l), status: linkActive(l).ok ? "active" : l.status === "revoked" ? "revoked" : "inactive", linkedAt: l.linkedAt, lastMessageAt: l.lastInboundAt ?? null, revokedAt: l.revokedAt ?? null }));
    // The business's CUSTOMER number (separate from BARRY's control number): its state and the team question.
    const cw = await customerWhatsappState(g.graph.business.id);
    const customerNumber = { state: cw.state, ...(cw.number ? { status: cw.number.status, coexistence: cw.number.coexistence, teamRepliesInApp: cw.number.teamRepliesInApp, display: cw.number.displayPhone ?? null, lastTeamReplySeenAt: cw.number.lastEchoAt ?? null } : {}) };
    return Response.json({ customerNumber, line: { configured: cfg.configured, via: cfg.via, sendMode: cfg.sendMode, display: cfg.display ?? null }, links });
  } catch (err) {
    return ownerFailure("whatsapp links", err);
  }
}

const Body = z.discriminatedUnion("action", [z.object({ businessId: z.string().min(1), action: z.literal("code") }), z.object({ businessId: z.string().min(1), action: z.literal("revoke"), id: z.string().min(3) }), z.object({ businessId: z.string().min(1), action: z.literal("team_replies"), value: z.boolean() })]);

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const g = ownerGraph(req, parsed.success ? parsed.data.businessId : undefined);
  if ("error" in g) return g.error;
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  try {
    if (parsed.data.action === "code") {
      const c = await createLinkCode(g.graph.business.id);
      return Response.json({ code: c.code, expiresAt: c.expiresAt, send: `LINK ${c.code}` });
    }
    if (parsed.data.action === "team_replies") {
      // The owner's answer: does the team keep replying to customers from the WhatsApp Business app?
      const cw = await customerWhatsappState(g.graph.business.id);
      if (!cw.number) return Response.json({ error: "No customer WhatsApp number is connected for this business yet." }, { status: 409 });
      const n = await setTeamRepliesInApp(g.graph.business.id, cw.number.phoneNumberId, parsed.data.value, "the owner (web)");
      return Response.json({ teamRepliesInApp: n.teamRepliesInApp, coexistence: n.coexistence });
    }
    const ok = await revokeOwnerIdentity(g.graph.business.id, parsed.data.id, "owner (web)");
    return ok ? Response.json({ revoked: true }) : Response.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    return ownerFailure("whatsapp link", err);
  }
}
