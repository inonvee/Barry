import { z } from "zod";
import { hqAuthError } from "@/lib/hq/auth";
import { createFounderLinkCode, founderLinkActive, founderRef, listFounderIdentities, maskedFounder, revokeFounderIdentity } from "@/lib/founder-channel/identity";

/**
 * FOUNDER WHATSAPP ACCESS — HQ founder session or founder bearer token only (the existing HQ authentication).
 *   GET                                 the linked founder numbers (masked) and whether each is active
 *   POST { action: "link_code" }        a one-time code (15 min) to send FROM the founder's phone to BARRY's founder line
 *   POST { action: "revoke", ref }      revoke a founder link immediately
 * Owner access can never reach this route; a code is shown once and only its hash is stored.
 */
const Body = z.discriminatedUnion("action", [z.object({ action: z.literal("link_code"), label: z.string().max(40).optional() }), z.object({ action: z.literal("revoke"), ref: z.string().regex(/^[a-f0-9]{16}$/) })]);

export async function GET(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const links = await listFounderIdentities();
  return Response.json({ identities: links.map((l) => ({ ref: founderRef(l.id), number: maskedFounder(l), status: l.status, active: founderLinkActive(l).ok, linkedAt: l.linkedAt, lastInboundAt: l.lastInboundAt ?? null, revokedAt: l.revokedAt ?? null, label: l.label ?? null })) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Body: { action: "link_code" } or { action: "revoke", ref }' }, { status: 400 });
  if (parsed.data.action === "link_code") {
    const { code, expiresAt } = await createFounderLinkCode({ label: parsed.data.label });
    return Response.json({ code, expiresAt, howTo: `Send "LINK ${code}" from your phone to BARRY's founder WhatsApp line within 15 minutes.` }, { headers: { "cache-control": "no-store" } });
  }
  const ref = parsed.data.ref;
  const link = (await listFounderIdentities()).find((l) => founderRef(l.id) === ref);
  const ok = link ? await revokeFounderIdentity(link.id, "founder (HQ)") : false;
  return Response.json({ revoked: ok }, { status: ok ? 200 : 404 });
}
