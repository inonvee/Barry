import { channelDisabled, loadControls } from "@/lib/hq/controls";
import { replyGate } from "@/lib/runtime/operating-mode";
import { recordUnsupportedMedia } from "./media";
import { renderRichText } from "./rich";
import { resolveCustomerIdentity } from "./identity";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { handleCustomerMessage, readInboundTurns } from "@/lib/runtime";
import { getConversationStore } from "@/lib/state";
import { ConversationBusyError, withConversationLock } from "@/lib/state/lock";
import { updateConversation } from "@/lib/state/update";
import { getInboxStore, INBOX_DONE, MAX_INBOUND_ATTEMPTS, needsWork, type InboxRow } from "./inbox";
import type { ChannelKind, NormalizedInboundMessage, NormalizedOutboundMessage } from "./types";
import { CHANNEL_DELIVERY_KEY, type DeliveryStatus } from "@/lib/operator/execution-state";

/**
 * THE CUSTOMER MESSAGING GATEWAY — one path from any channel to the same BARRY runtime.
 *
 *   channel webhook -> adapter (verify + normalize) -> gateway -> handleCustomerMessage -> reply
 *   -> outbound contract (text + rich parts rendered for the channel) -> adapter.send (or dry run)
 *
 * The gateway owns what every channel needs and no channel may skip:
 *  - identity/session mapping: one conversation per (business, channel, channel user);
 *  - idempotency: a channel message id is processed at most once — it is marked seen BEFORE the
 *    runtime runs, so a provider retry after a crash can never repeat a consequential action
 *    (the failure is recorded for the owner instead);
 *  - delivery: every outbound reply is recorded with its delivery result (sent / dry_run / failed);
 *  - no real message leaves unless the channel's send mode is explicitly live.
 */

export type DeliveryRecord = {
  at: string;
  channel: ChannelKind;
  inboundId: string;
  status: DeliveryStatus;
  /** The transcript message this delivery belongs to (its `at`), so an undelivered reply is never shown as said. */
  messageAt?: string;
  providerMessageId?: string;
  error?: string;
};

export { CHANNEL_DELIVERY_KEY };
export const CHANNEL_PROFILE_KEY = "__channelProfileName";
const MAX_DELIVERY = 50;

export function conversationIdFor(channel: ChannelKind, businessId: string, channelUserId: string): string {
  const prefix = channel === "whatsapp" ? "wa" : channel === "instagram" ? "ig" : "web";
  return `${prefix}:${businessId}:${channelUserId}`;
}

function readList<T>(value: string | undefined): T[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Render BARRY's reply (text + rich parts) as plain channel text — every channel can carry this. */
export function renderForTextChannel(out: NormalizedOutboundMessage): string {
  // Provider-independent rich model → plain text (no Markdown leaks; products named in the text are not repeated).
  return renderRichText(out);
}

export interface OutboundSender {
  readonly channel: ChannelKind;
  /** "live" sends for real; "dry_run" records what would have been sent and sends nothing. */
  readonly mode: "live" | "dry_run";
  send(to: string, text: string, context: { businessId: string }): Promise<{ providerMessageId?: string }>;
}

export type InboundResult =
  | { status: "processed"; conversationId: string; reply: string; delivery: DeliveryRecord }
  | { status: "duplicate"; conversationId: string }
  /** Kept, not answered: a person holds this conversation. */
  | { status: "held"; conversationId: string }
  /** Another request is working on this conversation and it didn't free up in time: nothing ran for this message yet — the provider should retry (a retry is deduplicated). */
  | { status: "queued"; conversationId: string; retry: true }
  /** retry=true: nothing was sent and the message can safely be processed again on a provider retry. */
  | { status: "failed"; conversationId: string; error: string; retry?: boolean };

type Inbound = NormalizedInboundMessage & { inboundId: string; profileName?: string };

/**
 * Process one normalized inbound message end to end — safely under bursts, retries and crashes:
 *
 *  1. CLAIM it in the durable inbox (unique per provider message id): a provider retry of a message that
 *     is done is a duplicate; one that isn't done joins the queue — it never runs twice.
 *  2. Take the CONVERSATION LOCK (one writer per conversation across all instances; other conversations
 *     are never blocked). If another request holds it, wait for it, bounded; if it doesn't free up, answer
 *     "queued" so the provider retries — the holder usually answers this message meanwhile.
 *  3. DRAIN the conversation's open messages in arrival order, each through its stages
 *     (processing → reply_ready → sending → sent), every stage persisted before the next step, so a
 *     crash at any point is resumed without repeating a turn or re-sending a reply.
 */
export async function processInbound(message: Inbound, sender: OutboundSender, opts: { waitMs?: number } = {}): Promise<InboundResult> {
  const graph = resolveBusinessGraph(message.businessId);
  const controls = await loadControls(graph.business.id);
  // A channel the founder disabled is not answered on: nothing is processed, nothing is sent.
  if (channelDisabled(controls, message.identity.channel) && !controls.pausedBusiness) {
    return { status: "failed", conversationId: message.conversationId, error: `channel ${message.identity.channel} is disabled by the founder` };
  }
  // Verified cross-channel identity: a linked identity resolves to its canonical customer; never by name.
  const resolved = await resolveCustomerIdentity(graph.business.id, message.identity);
  const customerId = resolved.linked ? resolved.customerId : message.customerId ?? resolved.customerId;
  const conversationId = message.conversationId;
  const inbox = getInboxStore();
  // Without the inbox (migration 0019) this throws ConcurrencyGuardMissingError: nothing runs, nothing is sent.
  const claimed = await inbox.claim({ businessId: graph.business.id, conversationId, channel: message.identity.channel, providerMessageId: message.inboundId, customerId, body: message.text, meta: { to: message.identity.channelUserId, ...(message.profileName ? { profileName: message.profileName.slice(0, 80) } : {}), ...(message.media ? { mediaType: message.media.type, ...(message.media.caption ? { caption: message.media.caption } : {}) } : {}) }, receivedAt: message.receivedAt });
  if (!claimed.created && INBOX_DONE.includes(claimed.row.status)) return { status: "duplicate", conversationId };
  // PAUSED (operating mode): the customer's message is kept — in the inbox and in the conversation the owner
  // reads — and nothing is answered, run or sent. Checked through the one operating-mode gate.
  const gate = replyGate(controls, message.identity.channel);
  if (!gate.allowed) {
    await withConversationLock(conversationId, async () => {
      const store = getConversationStore();
      const state = await store.getOrCreate(conversationId, graph.business.id, customerId);
      if (!state.messages.some((m) => m.role === "customer" && m.content === message.text && sameInstant(m.at, message.receivedAt))) {
        state.messages.push({ role: "customer", content: message.text, at: message.receivedAt });
        await store.save(state);
      }
      await inbox.update(claimed.row.id, { status: "skipped", error: `not answered: ${gate.reason}` });
    }, opts);
    return { status: "held", conversationId };
  }
  let advanced = new Set<string>();
  try {
    advanced = await withConversationLock(conversationId, () => drainConversation(conversationId, graph.business.id, sender), { waitMs: opts.waitMs ?? 20_000 });
  } catch (err) {
    if (err instanceof ConversationBusyError) return { status: "queued", conversationId, retry: true };
    throw err;
  }
  const mine = (await inbox.get(claimed.row.id))!;
  // A re-delivery whose work another request did is a duplicate. A NEW message reports its real outcome,
  // whichever request (e.g. the one already holding the conversation) processed it.
  if (!claimed.created && !advanced.has(mine.id) && INBOX_DONE.includes(mine.status)) return { status: "duplicate", conversationId };
  const delivery = readDeliveries((await getConversationStore().get(conversationId))?.knownFields ?? {}).filter((d) => d.inboundId === message.inboundId).at(-1);
  switch (mine.status) {
    case "sent":
    case "dry_run":
    case "send_failed":
      return { status: "processed", conversationId, reply: mine.reply ?? "", delivery: delivery ?? { at: mine.updatedAt, channel: sender.channel, inboundId: message.inboundId, status: mine.status === "send_failed" ? "failed" : mine.status } };
    case "skipped":
      return { status: "held", conversationId };
    case "failed":
      return { status: "failed", conversationId, error: mine.error ?? "not processed", retry: mine.attempts < MAX_INBOUND_ATTEMPTS };
    default:
      return { status: "failed", conversationId, error: mine.error ?? mine.status, retry: false };
  }
}

/** Work through every open inbound message of one conversation, oldest first. Caller holds the lock. Returns the rows it advanced. */
async function drainConversation(conversationId: string, businessId: string, sender: OutboundSender): Promise<Set<string>> {
  const inbox = getInboxStore();
  const tried = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const row = (await inbox.listByConversation(conversationId)).find((r) => !tried.has(r.id) && needsWork(r));
    if (!row) break;
    tried.add(row.id);
    await processInboxRow(row, businessId, sender);
  }
  return tried;
}

const sameInstant = (a?: string, b?: string) => Boolean(a && b && Date.parse(a) === Date.parse(b));

/** Advance one inbox row through its remaining stages. Every stage is persisted before the next step. */
async function processInboxRow(start: InboxRow, businessId: string, sender: OutboundSender): Promise<void> {
  const inbox = getInboxStore();
  const store = getConversationStore();
  const graph = resolveBusinessGraph(businessId);
  let row = start;

  // A send was started and its result never recorded. If the conversation's delivery record shows it
  // went out, finish the bookkeeping; otherwise the outcome is UNKNOWN — never re-send (fail closed).
  if (row.status === "sending") {
    const recorded = readDeliveries((await store.get(row.conversationId))?.knownFields ?? {}).filter((d) => d.inboundId === row.providerMessageId).at(-1);
    if (recorded) {
      await inbox.update(row.id, { status: recorded.status === "sent" ? "sent" : recorded.status === "dry_run" ? "dry_run" : "send_failed", ...(recorded.providerMessageId ? { providerReplyId: recorded.providerMessageId } : {}) }, "sending");
      return;
    }
    await inbox.update(row.id, { status: "delivery_unknown", error: "the reply may or may not have reached the customer; it was not sent again" }, "sending");
    await recordDelivery(row.conversationId, { at: new Date().toISOString(), channel: sender.channel, inboundId: row.providerMessageId, status: "failed", ...(row.replyAt ? { messageAt: row.replyAt } : {}), error: "delivery unknown — the send was interrupted; not re-sent" });
    return;
  }

  if (row.status !== "reply_ready") {
    // Did a turn for this exact message already run and save (e.g. we crashed right after it)? Then never run it again.
    const state = await store.get(row.conversationId);
    const stamp = state ? readInboundTurns(state.knownFields)[row.providerMessageId] : undefined;
    if (state && stamp?.held) {
      await inbox.update(row.id, { status: "skipped", error: "a person holds this conversation — BARRY did not reply" }, row.status);
      return;
    }
    if (state && stamp) {
      const reply = state.messages.find((m) => m.role === "barry" && sameInstant(m.at, stamp.replyAt));
      if (!reply) {
        await inbox.update(row.id, { status: "failed_final", error: "the turn ran but its reply can't be found; not repeated" }, row.status);
        return;
      }
      row = await inbox.update(row.id, { status: "reply_ready", reply: renderForTextChannel({ conversationId: row.conversationId, text: reply.content, rich: reply.rich }), replyAt: reply.at }, row.status);
    } else {
      // The channel's display name, once, for the owner's views (its own small, version-checked write).
      const profileName = typeof row.meta.profileName === "string" ? row.meta.profileName : undefined;
      if (profileName && !state?.knownFields[CHANNEL_PROFILE_KEY]) {
        await store.getOrCreate(row.conversationId, businessId, row.customerId);
        await updateConversation(row.conversationId, (s) => {
          if (!s.knownFields[CHANNEL_PROFILE_KEY]) s.knownFields[CHANNEL_PROFILE_KEY] = profileName;
        });
      }
      row = await inbox.update(row.id, { status: "processing", attempts: row.attempts + 1 }, row.status);
      // Media BARRY can't read: no model call — the message is kept and answered honestly (or held for a person).
      if (typeof row.meta.mediaType === "string") {
        const media = await recordUnsupportedMedia(graph, { conversationId: row.conversationId, customerId: row.customerId, inboundId: row.providerMessageId, type: row.meta.mediaType, caption: typeof row.meta.caption === "string" ? row.meta.caption : undefined, receivedAt: row.receivedAt });
        if (media.held || !media.reply) {
          await inbox.update(row.id, { status: "skipped", error: "a person holds this conversation — BARRY did not reply" }, "processing");
          return;
        }
        row = await inbox.update(row.id, { status: "reply_ready", reply: media.reply, ...(media.replyAt ? { replyAt: media.replyAt } : {}) }, "processing");
      } else {
        let out: Awaited<ReturnType<typeof handleCustomerMessage>>;
        try {
          out = await handleCustomerMessage(graph, row.conversationId, row.customerId, row.body, { inboundId: row.providerMessageId });
        } catch (err) {
          const error = err instanceof Error ? err.message.slice(0, 200) : "runtime error";
          const final = row.attempts >= MAX_INBOUND_ATTEMPTS;
          console.error("[barry:channel] inbound processing failed", { channel: row.channel, conversationId: row.conversationId, attempt: row.attempts, final, error });
          // Only if this request still owns the stage (a request that lost its lease never overwrites the one that took over).
          if (!(await inbox.update(row.id, { status: final ? "failed_final" : "failed", error }, "processing").then(() => true, () => false))) return;
          // Nothing was sent. The owner sees it; a provider retry may process it again (bounded).
          await recordDelivery(row.conversationId, { at: new Date().toISOString(), channel: sender.channel, inboundId: row.providerMessageId, status: "failed", error: `not processed: ${error}` }).catch(() => undefined);
          return;
        }
        // A person holds the conversation: the message is kept, BARRY sends nothing.
        if (out.held) {
          await inbox.update(row.id, { status: "skipped", error: "a person holds this conversation — BARRY did not reply" }, "processing");
          return;
        }
        // The turn is saved (and stamped with this message's id). If this write fails, the request fails and a
        // retry recovers the reply from that stamp — the turn is never run twice.
        const replyAt = [...out.state.messages].reverse().find((m) => m.role === "barry")?.at;
        row = await inbox.update(row.id, { status: "reply_ready", reply: renderForTextChannel({ conversationId: row.conversationId, text: out.response, rich: out.rich }), ...(replyAt ? { replyAt } : {}) }, "processing");
      }
    }
  }

  // Send — at most once. "sending" is persisted BEFORE the provider call.
  const text = row.reply ?? "";
  await inbox.update(row.id, { status: "sending" }, "reply_ready");
  let delivery: DeliveryRecord;
  try {
    const sent = sender.mode === "live" ? await sender.send(String(row.meta.to ?? row.customerId), text, { businessId }) : {};
    delivery = { at: new Date().toISOString(), channel: sender.channel, inboundId: row.providerMessageId, status: sender.mode === "live" ? "sent" : "dry_run", ...(row.replyAt ? { messageAt: row.replyAt } : {}), ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}) };
  } catch (err) {
    delivery = { at: new Date().toISOString(), channel: sender.channel, inboundId: row.providerMessageId, status: "failed", ...(row.replyAt ? { messageAt: row.replyAt } : {}), error: err instanceof Error ? err.message.slice(0, 200) : "send failed" };
  }
  // The conversation's record first (what the owner sees), then the inbox stage. If either write fails,
  // the row stays "sending": a retry finishes from the conversation's record or says "unknown" — never re-sends.
  try {
    await recordDelivery(row.conversationId, delivery);
    await inbox.update(row.id, { status: delivery.status === "sent" ? "sent" : delivery.status === "dry_run" ? "dry_run" : "send_failed", ...(delivery.providerMessageId ? { providerReplyId: delivery.providerMessageId } : {}), ...(delivery.error ? { error: delivery.error } : {}) }, "sending");
  } catch (err) {
    console.error("[barry:channel] delivery bookkeeping failed after the send; it will be reconciled, never re-sent", { conversationId: row.conversationId, error: err instanceof Error ? err.message : err });
  }
}

async function recordDelivery(conversationId: string, d: DeliveryRecord): Promise<void> {
  await updateConversation(conversationId, (state) => {
    state.knownFields[CHANNEL_DELIVERY_KEY] = JSON.stringify([...readList<DeliveryRecord>(state.knownFields[CHANNEL_DELIVERY_KEY]), d].slice(-MAX_DELIVERY));
    return undefined;
  });
}

export function readDeliveries(knownFields: Record<string, string>): DeliveryRecord[] {
  return readList<DeliveryRecord>(knownFields[CHANNEL_DELIVERY_KEY]);
}
