import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { listBusinessSummaries } from "@/lib/fixtures";
import { getBackend } from "@/lib/store";
import { executeOwnerCommand, recordDelivery, type OwnerCommandRecord, type TraceStep } from "@/lib/owner/command-service";
import { maskedIdentity, redeemLinkCode, resolveOwnerIdentity, touchInbound, type OwnerIdentity } from "./identity";
import { deliverOwner, type OwnerInbound, type OwnerOutbound, type OwnerSender } from "./transport";

/**
 * THE OWNER CHANNEL GATEWAY — one path from any owner messaging channel to the owner command service.
 *
 *   adapter (verified + normalized) → link code? → owner identity (exact, active, tenant-bound)
 *   → business (one link = that business; several = ask, never guess) → command service (idempotent
 *   by provider message id) → reply delivered (live or dry run) → delivery recorded on the command.
 *
 * Customer conversations never enter here (owner lines are distinct numbers), and nothing that arrives
 * here ever enters a customer conversation. An unknown, unverified or revoked sender gets one neutral
 * line and nothing about any business.
 */

export type OwnerInboundResult =
  | { status: "linked"; businessId: string; delivery: Awaited<ReturnType<typeof deliverOwner>> }
  | { status: "rejected"; reason: string; delivery?: Awaited<ReturnType<typeof deliverOwner>> }
  | { status: "ask_business"; businesses: string[]; delivery: Awaited<ReturnType<typeof deliverOwner>> }
  | { status: "processed" | "duplicate"; businessId: string; command: OwnerCommandRecord; delivery?: Awaited<ReturnType<typeof deliverOwner>> };

const NOT_LINKED = "This number isn't linked to a BARRY business. To link it, open Settings in BARRY, tap “Link WhatsApp” and send me the code.";
const LINK = /^\s*link\s+([A-Za-z0-9]{6,12})\s*$/i;

const businessName = (id: string) => listBusinessSummaries().find((b) => b.id === id)?.name ?? id;

export async function processOwnerInbound(inbound: OwnerInbound, sender: OwnerSender, opts: { now?: Date; businessIds?: string[]; /** The WhatsApp line it arrived on — remembered for proactive notices (WhatsApp's 24h window is per line). */ lineId?: string } = {}): Promise<OwnerInboundResult> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const reply = (m: OwnerOutbound) => deliverOwner(sender, inbound.channelUserId, m, now);

  // 1) Linking: a one-time code from a signed-in owner, sent FROM the number being linked.
  const code = inbound.text?.match(LINK)?.[1];
  if (code) {
    // A retried LINK delivery (Meta re-sends on a slow 2xx) never links or replies twice.
    const seenKey = `link:${inbound.channel}:${inbound.messageId}`.slice(0, 160);
    for (const b of opts.businessIds ?? listBusinessSummaries().map((x) => x.id)) {
      if ((await getBackend().listOperatorRecords(b, "owner_command")).some((r) => r.key === seenKey)) return { status: "rejected", reason: "duplicate link message (already handled)" };
    }
    const r = await redeemLinkCode({ code, channel: inbound.channel, channelUserId: inbound.channelUserId, verifiedIdentifier: inbound.verifiedIdentifier, now, ...(opts.businessIds ? { businessIds: opts.businessIds } : {}) });
    if (!r.ok) {
      console.warn("[barry:owner-channel] link refused", { reason: r.reason });
      return { status: "rejected", reason: `link: ${r.reason}`, delivery: await reply({ text: r.reason === "access_changed" ? "That code was made before your owner access changed. Get a new code in Settings." : "That code isn't valid or has expired. Get a new one in Settings → Link WhatsApp." }) };
    }
    await getBackend().upsertOperatorRecord({ businessId: r.link.businessId, kind: "owner_command", key: seenKey, data: { key: seenKey, kind: "link_inbound", at, by: maskedIdentity(r.link) } });
    if (opts.lineId) await touchInbound(r.link, at, opts.lineId);
    return { status: "linked", businessId: r.link.businessId, delivery: await reply({ text: `Linked. This number now operates ${businessName(r.link.businessId)} with BARRY.\nTry: “Who needs me?” or “What are you working on?”` }) };
  }

  // 2) Identity: exact, provider-verified, active, tenant-bound.
  const who = await resolveOwnerIdentity(inbound.channel, inbound.channelUserId, inbound.verifiedIdentifier, opts.businessIds);
  if (who.status === "unknown" || who.status === "inactive") {
    console.warn("[barry:owner-channel] sender is not an active owner", { status: who.status, detail: who.detail });
    return { status: "rejected", reason: `${who.status}: ${who.detail}`, delivery: await reply({ text: NOT_LINKED }) };
  }

  // 3) Business: one link = that business; several = the owner picks (never guessed).
  let link: OwnerIdentity | undefined = who.status === "resolved" ? who.link : undefined;
  let text = inbound.text;
  let actionId = inbound.actionId;
  let key = `${inbound.channel}:${inbound.messageId}`;
  if (who.status === "ambiguous") {
    const pick = actionId?.match(/^biz:([^:]+):(.+)$/);
    if (pick) {
      link = who.links.find((l) => l.businessId === pick[1]);
      if (!link) return { status: "rejected", reason: "business not linked to this sender", delivery: await reply({ text: "That business isn't linked to this number — nothing was done." }) };
      const pending = (await getBackend().listOperatorRecords(link.businessId, "owner_command")).map((r) => r.data as unknown as { key: string; text?: string; origin?: string }).find((c) => c.key === `pending:${link!.id}`);
      if (!pending?.text || pending.origin !== pick[2]) return { status: "rejected", reason: "no pending command", delivery: await reply({ text: "I don't have a message waiting for that choice — please send it again." }) };
      text = pending.text;
      actionId = undefined;
      key = `${inbound.channel}:${pick[2]}`;
    } else {
      const named = who.links.filter((l) => text && text.toLowerCase().includes(businessName(l.businessId).toLowerCase()));
      if (named.length === 1) link = named[0];
      else {
        for (const l of who.links) await getBackend().upsertOperatorRecord({ businessId: l.businessId, kind: "owner_command", key: `pending:${l.id}`, data: { key: `pending:${l.id}`, text: text ?? "", origin: inbound.messageId, createdAt: at } });
        return {
          status: "ask_business",
          businesses: who.links.map((l) => l.businessId),
          delivery: await reply({ text: `You operate ${who.links.length} businesses. Which one is this for?`, actions: who.links.slice(0, 3).map((l) => ({ id: `biz:${l.businessId}:${inbound.messageId}`, title: businessName(l.businessId).slice(0, 20) })) }),
        };
      }
    }
  }
  if (!link) return { status: "rejected", reason: "no business", delivery: await reply({ text: NOT_LINKED }) };

  // 4) The shared command service (idempotent by the provider message id).
  await touchInbound(link, at, opts.lineId);
  const graph = resolveBusinessGraph(link.businessId);
  const trace: TraceStep[] = [{ step: "identity", outcome: "ok", detail: `${inbound.channel} ${maskedIdentity(link)} → owner link ${link.id.replace(/\d(?=\d{4})/g, "•")} (active, verified ${link.linkedVia})`, at }];
  const result = await executeOwnerCommand({ graph, source: inbound.channel, actor: { kind: "whatsapp", identityId: link.id, masked: maskedIdentity(link) }, key, ...(text ? { text } : {}), ...(actionId ? { actionId } : {}), now, trace });
  if (result.duplicate) return { status: "duplicate", businessId: link.businessId, command: result.record };
  const delivery = await reply(result.reply);
  await recordDelivery(link.businessId, key, { status: delivery.status, at: delivery.at, ...(delivery.error ? { reason: delivery.error } : {}) });
  return { status: "processed", businessId: link.businessId, command: result.record, delivery };
}
