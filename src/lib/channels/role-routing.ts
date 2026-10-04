import type { OwnerInbound, OwnerSender } from "@/lib/owner-channel/transport";
import { ownerLinkCodeUsable, resolveOwnerIdentity } from "@/lib/owner-channel/identity";
import { founderLinkCodeUsable, resolveFounderIdentity } from "@/lib/founder-channel/identity";
import { whatsappFounderSender, whatsappOwnerSender, whatsappSender, type ParsedInbound } from "./whatsapp";
import type { OutboundSender } from "./gateway";

/**
 * SINGLE-NUMBER ROLE ROUTING — who a message on BARRY's routed WhatsApp number is FROM decides where it goes:
 *
 *   1. a verified, ACTIVE founder link (or a "LINK <code>" that is a valid HQ founder code) → Founder BARRY
 *   2. a verified, ACTIVE owner link for THIS line's business (or a valid owner code for it) → Owner BARRY
 *   3. everyone else → the normal customer flow
 *
 * Identity comes only from the provider-verified sender (Meta's wa_id) and the durable link records — never from the
 * message text: "I am the founder" is a customer message. A wrong / expired / foreign code grants nothing and is an
 * ordinary customer message. A revoked link falls straight back to the next rule. Each role keeps its OWN send mode.
 */

export type SharedLineRole = "founder" | "owner" | "customer";
const LINK = /^\s*link\s+([A-Za-z0-9]{6,14})\s*$/i;

export async function classifySender(m: ParsedInbound, now = new Date()): Promise<SharedLineRole> {
  const id = m.identity;
  if (!id.verifiedIdentifier) return "customer";
  const code = m.command?.text?.match(LINK)?.[1];
  if (code) {
    if (await founderLinkCodeUsable(code, "whatsapp", id.channelUserId, now)) return "founder";
    if (await ownerLinkCodeUsable(m.businessId, code, "whatsapp", id.channelUserId, now)) return "owner";
  }
  if ((await resolveFounderIdentity("whatsapp", id.channelUserId, id.verifiedIdentifier)).status === "resolved") return "founder";
  if ((await resolveOwnerIdentity("whatsapp", id.channelUserId, id.verifiedIdentifier, [m.businessId])).status === "resolved") return "owner";
  return "customer";
}

/** The founder / owner view of a routed message (only ever built after classifySender said so). */
export function asCommandInbound(m: ParsedInbound): OwnerInbound {
  return { channel: "whatsapp", messageId: m.inboundId, channelUserId: m.identity.channelUserId, ...(m.identity.verifiedIdentifier ? { verifiedIdentifier: m.identity.verifiedIdentifier } : {}), receivedAt: m.receivedAt ?? new Date().toISOString(), ...(m.command?.text ? { text: m.command.text } : !m.command?.actionId ? { text: m.text } : {}), ...(m.command?.actionId ? { actionId: m.command.actionId } : {}) };
}

// ── Role senders: the send mode follows the ROLE (gateway), never the receiving number ─────────────────────────

export type RoleSenders = { customer: () => OutboundSender; owner: (lineId?: string) => OwnerSender; founder: (lineId?: string) => OwnerSender };
let override: RoleSenders | undefined;
/** QA / tests: replace every role's sender (QA only ever makes them DRY — recording, never sending). */
export function setRoleSendersOverride(o: RoleSenders | undefined): void {
  override = o;
}
export const roleSenders: RoleSenders = {
  customer: () => override?.customer() ?? whatsappSender(),
  owner: (lineId) => override?.owner(lineId) ?? whatsappOwnerSender(fetch, lineId),
  founder: (lineId) => override?.founder(lineId) ?? whatsappFounderSender(fetch, lineId),
};
