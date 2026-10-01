import { getBackend } from "@/lib/store";
import type { OperatorRecord } from "@/lib/store/types";
import { canLinkIdentities, type ChannelIdentity } from "./types";

/**
 * VERIFIED CROSS-CHANNEL IDENTITY — two channel identities of one business are linked ONLY when both
 * carry the same provider-verified identifier (a verified phone, a verified account id). Names,
 * similar handles or timing never link anyone. A link maps each identity to one canonical customer id
 * so conversation, cart, transaction and history continuity is preserved where the runtime supports it.
 */

export type IdentityLink = { id: string; businessId: string; verifiedIdentifier: string; canonicalCustomerId: string; identities: { channel: ChannelIdentity["channel"]; channelUserId: string; linkedAt: string }[]; createdAt: string; updatedAt: string };

const keyFor = (verifiedIdentifier: string) => `link:${verifiedIdentifier}`;

export async function listIdentityLinks(businessId: string): Promise<IdentityLink[]> {
  const records = await getBackend().listOperatorRecords(businessId, "channel_identity");
  return records.map((r: OperatorRecord) => r.data as unknown as IdentityLink).filter((l) => l && typeof l.verifiedIdentifier === "string");
}

/** The canonical customer id for an identity: its link's, or the channel-local id. Never guesses. */
export async function resolveCustomerIdentity(businessId: string, identity: ChannelIdentity): Promise<{ customerId: string; linked: boolean; verified: boolean }> {
  const local = `${identity.channel}:${identity.channelUserId}`;
  if (!identity.verifiedIdentifier) return { customerId: local, linked: false, verified: false };
  const link = (await listIdentityLinks(businessId)).find((l) => l.verifiedIdentifier === identity.verifiedIdentifier);
  if (!link) return { customerId: local, linked: false, verified: true };
  return { customerId: link.canonicalCustomerId, linked: true, verified: true };
}

/** Link two identities. Refused unless both are verified with the SAME identifier. Idempotent. */
export async function linkIdentities(businessId: string, a: ChannelIdentity, b: ChannelIdentity, now = new Date()): Promise<{ ok: true; link: IdentityLink } | { ok: false; reason: string }> {
  if (!canLinkIdentities(a, b)) return { ok: false, reason: "identities can only be linked through the same provider-verified identifier" };
  const at = now.toISOString();
  const verifiedIdentifier = a.verifiedIdentifier!;
  const existing = (await listIdentityLinks(businessId)).find((l) => l.verifiedIdentifier === verifiedIdentifier);
  const identities = [...(existing?.identities ?? [])];
  for (const i of [a, b]) if (!identities.some((x) => x.channel === i.channel && x.channelUserId === i.channelUserId)) identities.push({ channel: i.channel, channelUserId: i.channelUserId, linkedAt: at });
  const link: IdentityLink = { id: keyFor(verifiedIdentifier), businessId, verifiedIdentifier, canonicalCustomerId: existing?.canonicalCustomerId ?? `${a.channel}:${a.channelUserId}`, identities, createdAt: existing?.createdAt ?? at, updatedAt: at };
  await getBackend().upsertOperatorRecord({ businessId, kind: "channel_identity", key: link.id, data: link });
  return { ok: true, link };
}

/** Conversations that belong to one linked customer (for continuity views). Pure. */
export function conversationsOfLink(link: IdentityLink, conversationIds: string[]): string[] {
  const prefixes = link.identities.map((i) => `${i.channel === "whatsapp" ? "wa" : i.channel === "instagram" ? "ig" : "web"}:${link.businessId}:${i.channelUserId}`);
  return conversationIds.filter((id) => prefixes.some((p) => id === p || id.startsWith(`${p}:`)));
}
