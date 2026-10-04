import crypto from "node:crypto";
import { getBackend } from "@/lib/store";
import { FLEET_SCOPE } from "@/lib/release/manifest";
import { hqConfig } from "@/lib/hq/auth";

/**
 * FOUNDER IDENTITY — who may command Founder BARRY over a messaging channel.
 *
 * A message is NEVER a founder command because of what it says or where it came from. It is one only when the
 * sender's provider-verified identity (the WhatsApp number Meta delivered it from) has an ACTIVE founder link.
 * A founder link is created only by:
 *   1. the founder, signed in to HQ (founder session / founder token — the existing HQ authentication), asking for
 *      a one-time code (15 minutes, stored as a hash, single use), and
 *   2. that code arriving FROM the number being linked, on BARRY's founder line — proving possession of it.
 *
 * Founder links are separate records from owner links (fleet scope, their own codes): an owner link, an owner
 * code or an owner session can never create or become one. Each link carries a fingerprint of the founder
 * credential at link time — rotating BARRY_FOUNDER_TOKEN (which already ends HQ sessions) ends every founder
 * link made under it; with HQ disabled no founder link works. Revoked links stop immediately.
 */

export type FounderChannelKind = "whatsapp";

export type FounderIdentity = {
  id: string;
  channel: FounderChannelKind;
  channelUserId: string;
  verifiedIdentifier: string;
  status: "active" | "revoked";
  linkedAt: string;
  linkedVia: "hq_founder_code";
  accessFingerprint: string;
  label?: string;
  lastInboundAt?: string;
  revokedAt?: string;
  revokedBy?: string;
};

type FounderLinkCode = { hash: string; createdAt: string; expiresAt: string; usedAt?: string; usedBy?: string; accessFingerprint: string; label?: string };

const KIND = "founder_state" as const;
const IDENTITY = "founder_identity:";
const CODE = "founder_link_code:";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_MINUTES = 15;
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const founderIdentityKey = (channel: FounderChannelKind, channelUserId: string) => `${channel}:${channelUserId.replace(/\D/g, "")}`;

/** The fingerprint of the founder credential that opens HQ right now (never the credential itself). */
export function founderAccessFingerprint(): string {
  const c = hqConfig();
  return c.enabled ? hash(`founder-access:${c.token}`).slice(0, 24) : "unavailable";
}

export function founderLinkActive(link: FounderIdentity): { ok: true } | { ok: false; reason: "revoked" | "access_changed" | "access_unavailable" } {
  if (link.status !== "active") return { ok: false, reason: "revoked" };
  const now = founderAccessFingerprint();
  if (now === "unavailable") return { ok: false, reason: "access_unavailable" };
  return now === link.accessFingerprint ? { ok: true } : { ok: false, reason: "access_changed" };
}

/** A one-time founder link code. The CALLER must already be the HQ-authenticated founder. Only the hash is stored. */
export async function createFounderLinkCode(opts: { now?: Date; label?: string } = {}): Promise<{ code: string; expiresAt: string }> {
  const now = opts.now ?? new Date();
  const fp = founderAccessFingerprint();
  if (fp === "unavailable") throw new Error("Founder access (HQ) is not configured");
  const bytes = crypto.randomBytes(10);
  const code = `F${Array.from(bytes.subarray(0, 9), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("")}`;
  const rec: FounderLinkCode = { hash: hash(code), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + CODE_MINUTES * 60_000).toISOString(), accessFingerprint: fp, ...(opts.label ? { label: opts.label.slice(0, 40) } : {}) };
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: KIND, key: `${CODE}${rec.hash}`, data: rec as unknown as Record<string, unknown> });
  return { code, expiresAt: rec.expiresAt };
}

export async function listFounderIdentities(): Promise<FounderIdentity[]> {
  return (await getBackend().listOperatorRecords(FLEET_SCOPE, KIND)).filter((r) => r.key.startsWith(IDENTITY)).map((r) => r.data as unknown as FounderIdentity).filter((l) => l && typeof l.channelUserId === "string");
}

async function saveIdentity(link: FounderIdentity): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: KIND, key: `${IDENTITY}${link.id}`, data: link as unknown as Record<string, unknown> });
}

/** Redeem a founder code sent FROM a provider-verified identity. Single use; expiry and the founder fingerprint enforced. */
export async function redeemFounderLinkCode(input: { code: string; channel: FounderChannelKind; channelUserId: string; verifiedIdentifier?: string; now?: Date }): Promise<{ ok: true; link: FounderIdentity } | { ok: false; reason: "unverified_sender" | "invalid_or_expired" | "access_changed" }> {
  const now = input.now ?? new Date();
  if (!input.verifiedIdentifier) return { ok: false, reason: "unverified_sender" };
  const h = hash(input.code.trim().toUpperCase());
  const id = founderIdentityKey(input.channel, input.channelUserId);
  const rec = (await getBackend().listOperatorRecords(FLEET_SCOPE, KIND)).find((r) => r.key === `${CODE}${h}`);
  if (!rec) return { ok: false, reason: "invalid_or_expired" };
  const c = rec.data as unknown as FounderLinkCode;
  if (c.usedAt && c.usedBy === id) {
    const existing = (await listFounderIdentities()).find((l) => l.id === id);
    if (existing && existing.status === "active") return { ok: true, link: existing };
  }
  if (c.usedAt || Date.parse(c.expiresAt) < now.getTime()) return { ok: false, reason: "invalid_or_expired" };
  if (c.accessFingerprint !== founderAccessFingerprint()) return { ok: false, reason: "access_changed" };
  // Marked used BEFORE the link is written: a replayed code can never create a second binding.
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: KIND, key: `${CODE}${h}`, data: { ...c, usedAt: now.toISOString(), usedBy: id } as unknown as Record<string, unknown> });
  const link: FounderIdentity = { id, channel: input.channel, channelUserId: input.channelUserId.replace(/\D/g, ""), verifiedIdentifier: input.verifiedIdentifier, status: "active", linkedAt: now.toISOString(), linkedVia: "hq_founder_code", accessFingerprint: c.accessFingerprint, ...(c.label ? { label: c.label } : {}), lastInboundAt: now.toISOString() };
  await saveIdentity(link);
  return { ok: true, link };
}

export async function revokeFounderIdentity(id: string, by: string, now = new Date()): Promise<boolean> {
  const link = (await listFounderIdentities()).find((l) => l.id === id);
  if (!link || link.status === "revoked") return false;
  await saveIdentity({ ...link, status: "revoked", revokedAt: now.toISOString(), revokedBy: by });
  return true;
}

export async function touchFounderInbound(link: FounderIdentity, at: string): Promise<void> {
  await saveIdentity({ ...link, lastInboundAt: at });
}

export type FounderResolution = { status: "unknown" | "inactive"; detail: string } | { status: "resolved"; link: FounderIdentity };

/** Exact, provider-verified identity only (no prefix / similarity / name recognition). */
export async function resolveFounderIdentity(channel: FounderChannelKind, channelUserId: string, verifiedIdentifier: string | undefined): Promise<FounderResolution> {
  if (!verifiedIdentifier) return { status: "unknown", detail: "the sender is not provider-verified" };
  const id = founderIdentityKey(channel, channelUserId);
  const link = (await listFounderIdentities()).find((l) => l.id === id && l.verifiedIdentifier === verifiedIdentifier);
  if (!link) return { status: "unknown", detail: "no founder link for this sender" };
  const active = founderLinkActive(link);
  return active.ok ? { status: "resolved", link } : { status: "inactive", detail: active.reason };
}

/** An opaque reference to a founder link (HQ lists and revokes by it — never the phone number). */
export const founderRef = (id: string) => crypto.createHash("sha256").update(`founder-ref:${id}`).digest("hex").slice(0, 16);

export const maskedFounder = (link: Pick<FounderIdentity, "channelUserId">) => `···${link.channelUserId.slice(-4)}`;
