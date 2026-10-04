import { getBackend } from "@/lib/store";
import { FLEET_SCOPE } from "@/lib/release/manifest";
import { executeFounderCommand, getFounderCommand, type FounderReply } from "@/lib/founder/command-service";
import type { FounderInterpreter } from "@/lib/founder/command";
import { modelFounderInterpreter } from "@/lib/founder/model-interpreter";
import { modelFounderComposer, type FounderComposer } from "@/lib/founder/voice";
import { UI } from "@/lib/founder/i18n";
import { deliverOwner, type OwnerInbound, type OwnerOutbound, type OwnerSender } from "@/lib/owner-channel/transport";
import { maskedFounder, redeemFounderLinkCode, resolveFounderIdentity, touchFounderInbound, type FounderIdentity } from "./identity";

/**
 * THE FOUNDER CHANNEL GATEWAY — BARRY's founder line → the SAME Founder BARRY command service HQ uses.
 *
 *   adapter (verified + normalized, founder line only) → link code? → founder identity (exact, active, bound to the
 *   current founder credential) → founder session (the business in focus, fresh only) → executeFounderCommand
 *   (interpretation → grounding → authority → confirmation → audited founder control → verification → durable
 *   trace) → reply delivered (live or dry run).
 *
 * Nothing here decides anything: it carries who is speaking (a verified founder identity) and what the
 * conversation is about (a business in focus that EXPIRES), and renders the reply. Customer and owner messages
 * never arrive here (separate lines), and an unknown / revoked sender gets one neutral line and nothing else.
 */

export const FOUNDER_CONTEXT_TTL_MS = 15 * 60_000;
const KIND = "founder_state" as const;
const SESSION = "founder_session:";
const INBOUND = "founder_inbound:";
const LINK = /^\s*link\s+([A-Za-z0-9]{6,14})\s*$/i;

export type FounderSession = { identityId: string; lastKey?: string; businessId?: string; updatedAt: string };

export type FounderInboundResult =
  | { status: "linked"; delivery: Awaited<ReturnType<typeof deliverOwner>> }
  | { status: "rejected"; reason: string; delivery?: Awaited<ReturnType<typeof deliverOwner>> }
  | { status: "processed" | "duplicate"; key: string; reply: FounderReply; outbound: OwnerOutbound; delivery?: Awaited<ReturnType<typeof deliverOwner>> };

async function loadSession(identityId: string, now: Date): Promise<FounderSession> {
  const r = (await getBackend().listOperatorRecords(FLEET_SCOPE, KIND)).find((x) => x.key === `${SESSION}${identityId}`);
  const s = r?.data as unknown as FounderSession | undefined;
  // Expired context reads as empty: an old business focus or an old pending confirmation can never be acted on.
  if (!s || now.getTime() - Date.parse(s.updatedAt) > FOUNDER_CONTEXT_TTL_MS) return { identityId, updatedAt: now.toISOString() };
  return s;
}
async function saveSession(s: FounderSession): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: KIND, key: `${SESSION}${s.identityId}`, data: s as unknown as Record<string, unknown> });
}
export async function readFounderSession(identityId: string, now = new Date()): Promise<FounderSession> {
  return loadSession(identityId, now);
}

/** The founder-facing message for a Founder BARRY reply: the answer, a Confirm button when a control waits. */
export function founderOutbound(reply: FounderReply): OwnerOutbound {
  const lang = reply.language ?? "en";
  const base = process.env.BARRY_PUBLIC_URL?.replace(/\/$/, "") || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  const href = reply.items.find((i) => i.href)?.href;
  return {
    text: reply.answer.slice(0, 3500),
    ...(reply.confirmation ? { actions: [{ id: `fc:${reply.confirmation.key}:confirm`, title: UI[lang].confirm }] } : {}),
    ...(base && href ? { links: [{ label: "HQ", href: `${base}${href}` }] } : {}),
  };
}

export async function processFounderInbound(inbound: OwnerInbound, sender: OwnerSender, opts: { now?: Date; interpreter?: FounderInterpreter | null; composer?: FounderComposer | null } = {}): Promise<FounderInboundResult> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const reply = (m: OwnerOutbound) => deliverOwner(sender, inbound.channelUserId, m, now);

  // 1) Linking: a one-time code from the HQ-authenticated founder, sent FROM the number being linked.
  const code = inbound.text?.match(LINK)?.[1];
  if (code) {
    const r = await redeemFounderLinkCode({ code, channel: inbound.channel, channelUserId: inbound.channelUserId, verifiedIdentifier: inbound.verifiedIdentifier, now });
    if (!r.ok) {
      // No reply: the founder line answers only verified founders (it may be LIVE while every other line is dry run).
      // The founder sees the failure in HQ (no new linked number) and simply gets a new code.
      console.warn("[barry:founder-channel] link refused", { reason: r.reason });
      return { status: "rejected", reason: `link: ${r.reason}` };
    }
    return { status: "linked", delivery: await reply({ text: "Linked. This number now has founder access to BARRY.\nTry: “What do I need to know today?” / “מה קורה היום?”" }) };
  }

  // 2) Identity: exact, provider-verified, active, bound to the current founder credential.
  const who = await resolveFounderIdentity(inbound.channel, inbound.channelUserId, inbound.verifiedIdentifier);
  if (who.status !== "resolved") {
    // An unknown, unverified or revoked sender gets NOTHING back — not even a neutral line — and nothing runs.
    console.warn("[barry:founder-channel] sender is not an active founder", { status: who.status, detail: who.detail });
    return { status: "rejected", reason: `${who.status}: ${who.detail}` };
  }
  const link: FounderIdentity = who.link;
  const masked = maskedFounder(link);
  const actor = { kind: "founder" as const, via: "whatsapp" as const, identity: masked };
  const key = `whatsapp:${inbound.messageId}`.slice(0, 120);

  // 3) The same provider message again (Meta retries): never processed or answered twice. The recorded result is
  //    returned (a text command by its key; a confirmation as a replay — nothing runs again) and nothing is re-sent.
  const tap = inbound.actionId?.match(/^fc:(.+):confirm$/);
  const seen = (await getBackend().listOperatorRecords(FLEET_SCOPE, KIND)).find((r) => r.key === `${INBOUND}${inbound.messageId}`);
  if (seen) {
    const d = seen.data as { key: string; confirmKey?: string };
    const r = d.confirmKey ? await executeFounderCommand({ actor, key, confirmKey: d.confirmKey, now }) : await executeFounderCommand({ actor, key: d.key, text: inbound.text ?? "", now });
    return { status: "duplicate", key: d.confirmKey ?? d.key, reply: r, outbound: founderOutbound(r) };
  }
  await getBackend().upsertOperatorRecord({ businessId: FLEET_SCOPE, kind: KIND, key: `${INBOUND}${inbound.messageId}`, data: { key, ...(tap ? { confirmKey: tap[1] } : {}), at, by: masked } });
  await touchFounderInbound(link, at);

  // 4) Context: the business in focus and the previous turn — only while fresh.
  const session = await loadSession(link.id, now);
  const interpreter = opts.interpreter === null ? undefined : (opts.interpreter ?? modelFounderInterpreter());
  const composer = opts.composer === null ? undefined : (opts.composer ?? modelFounderComposer());
  let out: FounderReply;
  if (inbound.actionId && !tap) {
    return { status: "rejected", reason: "unknown action", delivery: await reply({ text: "I couldn't match that button to anything I sent you — nothing was done." }) };
  }
  if (tap) {
    // A Confirm button confirms only a pending control THIS founder identity asked for.
    const pending = await getFounderCommand(tap[1]);
    if (!pending || pending.founder !== `founder (whatsapp ${masked})`) {
      return { status: "rejected", reason: "confirmation not owned by this identity", delivery: await reply({ text: "That confirmation doesn't match a request from this number — nothing was done." }) };
    }
    out = await executeFounderCommand({ actor, key, confirmKey: tap[1], now });
  } else {
    out = await executeFounderCommand({ actor, key, text: inbound.text ?? "", ...(session.lastKey ? { previousKey: session.lastKey } : {}), ...(session.businessId ? { context: { businessId: session.businessId } } : {}), now, ...(interpreter ? { interpreter } : {}), ...(composer ? { composer } : {}) });
  }

  // 5) The new context: one business in scope → it is the focus; anything fleet-wide or unclear clears it.
  const single = out.scope.kind === "business" && out.scope.businessIds.length === 1 ? out.scope.businessIds[0] : undefined;
  await saveSession({ identityId: link.id, lastKey: tap ? tap[1] : out.key, ...(single ? { businessId: single } : {}), updatedAt: new Date().toISOString() });

  const outbound = founderOutbound(out);
  const delivery = await reply(outbound);
  return { status: out.duplicate && !tap ? "duplicate" : "processed", key: out.key, reply: out, outbound, delivery };
}
