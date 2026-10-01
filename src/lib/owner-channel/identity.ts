import crypto from "node:crypto";
import { getBackend } from "@/lib/store";
import { ownerAccessConfigured, perBusinessTokens } from "@/lib/owner-auth";
import { isProductionRuntime } from "@/lib/env";
import { listBusinessSummaries } from "@/lib/fixtures";

const fleetTenantIds = () => listBusinessSummaries().map((b) => b.id);

/**
 * OWNER IDENTITY — who may command BARRY over a messaging channel, and for which business.
 *
 * A channel message is NEVER an owner command because of where it came from. It is one only when the
 * sender's provider-verified identity (e.g. the WhatsApp number Meta delivered it from) has an ACTIVE
 * link to a business. A link is created only by:
 *   1. an owner signed in to that business on the web asking for a one-time code (15 minutes, stored as
 *      a hash, single use), and
 *   2. that code arriving FROM the number being linked — proving possession of it.
 * Each link binds ONE business. Its validity is re-checked on every message:
 *   - revoked links stop immediately;
 *   - each link carries a fingerprint of the business's owner access at link time — rotating the owner
 *     token (which already ends web sessions) also ends every WhatsApp link made under it;
 *   - with no owner access configured, links work only outside production (local / tests).
 * Owner links never carry founder authority: the founder control plane has its own credentials.
 */

export type OwnerChannelKind = "whatsapp";

export type OwnerIdentity = {
  id: string;
  businessId: string;
  channel: OwnerChannelKind;
  /** The provider's user id (WhatsApp: the wa_id digits). */
  channelUserId: string;
  /** e.g. "phone:972501234567" — what the provider verified. */
  verifiedIdentifier: string;
  status: "active" | "revoked";
  linkedAt: string;
  linkedVia: "owner_session_code";
  accessFingerprint: string;
  lastInboundAt?: string;
  revokedAt?: string;
  revokedBy?: string;
};

export type LinkCode = { hash: string; businessId: string; createdAt: string; expiresAt: string; usedAt?: string; usedBy?: string; accessFingerprint: string };

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_MINUTES = 15;

const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const identityKey = (channel: OwnerChannelKind, channelUserId: string) => `${channel}:${channelUserId.replace(/\D/g, "")}`;

/** The fingerprint of the owner access that opens this business right now (never the token itself). */
export function ownerAccessFingerprint(businessId: string): string {
  if (!ownerAccessConfigured()) return isProductionRuntime() ? "unavailable" : "open-dev";
  const token = perBusinessTokens().get(businessId) ?? process.env.BARRY_OWNER_TOKEN ?? "";
  return token ? hash(`owner-access:${businessId}:${token}`).slice(0, 24) : "unavailable";
}

/** Is this link usable right now? Revoked, or made under owner access that has since changed → no. */
export function linkActive(link: OwnerIdentity): { ok: true } | { ok: false; reason: "revoked" | "access_changed" | "access_unavailable" } {
  if (link.status !== "active") return { ok: false, reason: "revoked" };
  const now = ownerAccessFingerprint(link.businessId);
  if (now === "unavailable") return { ok: false, reason: "access_unavailable" };
  return now === link.accessFingerprint ? { ok: true } : { ok: false, reason: "access_changed" };
}

/** A one-time link code for a signed-in owner of `businessId`. Only the hash is stored. */
export async function createLinkCode(businessId: string, now = new Date()): Promise<{ code: string; expiresAt: string }> {
  const bytes = crypto.randomBytes(8);
  const code = Array.from(bytes.subarray(0, 8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  const rec: LinkCode = { hash: hash(code), businessId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + CODE_MINUTES * 60_000).toISOString(), accessFingerprint: ownerAccessFingerprint(businessId) };
  await getBackend().upsertOperatorRecord({ businessId, kind: "owner_link_code", key: rec.hash, data: rec as unknown as Record<string, unknown> });
  return { code, expiresAt: rec.expiresAt };
}

export async function listOwnerIdentities(businessId: string): Promise<OwnerIdentity[]> {
  return (await getBackend().listOperatorRecords(businessId, "owner_identity")).map((r) => r.data as unknown as OwnerIdentity).filter((l) => l && typeof l.channelUserId === "string");
}

async function saveIdentity(link: OwnerIdentity): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: link.businessId, kind: "owner_identity", key: link.id, data: link as unknown as Record<string, unknown> });
}

/**
 * Redeem a code sent FROM a provider-verified identity. Exactly one business; single use; expiry and
 * owner-access fingerprint enforced. Idempotent for the same identity re-sending the same code.
 */
export async function redeemLinkCode(input: { code: string; channel: OwnerChannelKind; channelUserId: string; verifiedIdentifier?: string; now?: Date; businessIds?: string[] }): Promise<{ ok: true; link: OwnerIdentity } | { ok: false; reason: "unverified_sender" | "invalid_or_expired" | "access_changed" }> {
  const now = input.now ?? new Date();
  if (!input.verifiedIdentifier) return { ok: false, reason: "unverified_sender" };
  const h = hash(input.code.trim().toUpperCase());
  const id = identityKey(input.channel, input.channelUserId);
  for (const businessId of input.businessIds ?? fleetTenantIds()) {
    const rec = (await getBackend().listOperatorRecords(businessId, "owner_link_code")).find((r) => r.key === h);
    if (!rec) continue;
    const c = rec.data as unknown as LinkCode;
    if (c.usedAt && c.usedBy === id) {
      const existing = (await listOwnerIdentities(businessId)).find((l) => l.id === id);
      if (existing && existing.status === "active") return { ok: true, link: existing };
    }
    if (c.usedAt || Date.parse(c.expiresAt) < now.getTime()) return { ok: false, reason: "invalid_or_expired" };
    if (c.accessFingerprint !== ownerAccessFingerprint(businessId)) return { ok: false, reason: "access_changed" };
    // Marked used BEFORE the link is written: a replayed code can never create a second binding.
    await getBackend().upsertOperatorRecord({ businessId, kind: "owner_link_code", key: h, data: { ...c, usedAt: now.toISOString(), usedBy: id } as unknown as Record<string, unknown> });
    const link: OwnerIdentity = { id, businessId, channel: input.channel, channelUserId: input.channelUserId.replace(/\D/g, ""), verifiedIdentifier: input.verifiedIdentifier, status: "active", linkedAt: now.toISOString(), linkedVia: "owner_session_code", accessFingerprint: c.accessFingerprint, lastInboundAt: now.toISOString() };
    await saveIdentity(link);
    return { ok: true, link };
  }
  return { ok: false, reason: "invalid_or_expired" };
}

export async function revokeOwnerIdentity(businessId: string, id: string, by: string, now = new Date()): Promise<boolean> {
  const link = (await listOwnerIdentities(businessId)).find((l) => l.id === id);
  if (!link) return false;
  await saveIdentity({ ...link, status: "revoked", revokedAt: now.toISOString(), revokedBy: by });
  return true;
}

export async function touchInbound(link: OwnerIdentity, at: string): Promise<void> {
  await saveIdentity({ ...link, lastInboundAt: at });
}

export type IdentityResolution =
  | { status: "unknown"; detail: string }
  | { status: "inactive"; detail: string }
  | { status: "resolved"; link: OwnerIdentity }
  | { status: "ambiguous"; links: OwnerIdentity[] };

/**
 * Which business(es) a verified sender may operate. Exact identity only (no prefix / similarity), each
 * business read on its own (tenant-scoped reads). Several active links = ambiguous — never guessed.
 */
export async function resolveOwnerIdentity(channel: OwnerChannelKind, channelUserId: string, verifiedIdentifier: string | undefined, businessIds: string[] = fleetTenantIds()): Promise<IdentityResolution> {
  if (!verifiedIdentifier) return { status: "unknown", detail: "the sender is not provider-verified" };
  const id = identityKey(channel, channelUserId);
  const found: OwnerIdentity[] = [];
  for (const b of businessIds) {
    const link = (await listOwnerIdentities(b)).find((l) => l.id === id && l.verifiedIdentifier === verifiedIdentifier && l.businessId === b);
    if (link) found.push(link);
  }
  if (found.length === 0) return { status: "unknown", detail: "no owner link for this sender" };
  const active = found.filter((l) => linkActive(l).ok);
  if (active.length === 0) {
    const why = linkActive(found[0]);
    return { status: "inactive", detail: why.ok ? "inactive" : why.reason };
  }
  return active.length === 1 ? { status: "resolved", link: active[0] } : { status: "ambiguous", links: active };
}

/** "···4567" — owner-facing; never the full number. */
export function maskedIdentity(link: Pick<OwnerIdentity, "channelUserId">): string {
  return `···${link.channelUserId.slice(-4)}`;
}
