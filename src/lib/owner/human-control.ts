import type { BusinessGraph } from "@/lib/business-graph";
import { getConversationStore, type ConversationState } from "@/lib/state";
import { withConversationLock } from "@/lib/state/lock";
import { updateConversation } from "@/lib/state/update";
import { giveToHuman, readControl, readOwnerReplies, returnToBarry, takeOverBy, writeOwnerReply, type ConversationControl, type OwnerReplyRecord } from "@/lib/runtime/control";
import { CHANNEL_DELIVERY_KEY, type DeliveryRecord, type OutboundSender } from "@/lib/channels/gateway";
import { whatsappConfig, whatsappSender } from "@/lib/channels/whatsapp";
import { WHATSAPP_WINDOW_MS } from "@/lib/operator/executor";

/**
 * THE OWNER HOLDS A CONVERSATION — one service for every owner surface (web cockpit, owner WhatsApp):
 * take it over, reply to the customer through BARRY's channel, return it to BARRY. Every write is under
 * the conversation's lock and version-checked (Phase 3), so it can never race a BARRY turn: either BARRY's
 * turn finishes first (and its reply was already sent), or the owner's change lands first (and BARRY's turn
 * then sees a person holding the conversation and stays silent).
 *
 * An owner reply is the owner's message (role "owner", with its author) — never BARRY's. It is sent at most
 * once per request id: the attempt is persisted before the channel call; a retry returns what happened,
 * and an interrupted send is reported as unknown, never sent again.
 */

export class OwnerControlError extends Error {
  constructor(readonly code: "not_found" | "empty" | "outside_whatsapp_window", message: string) {
    super(message);
    this.name = "OwnerControlError";
  }
}

export type SenderFor = (conversation: ConversationState) => OutboundSender;

let sendersForTests: SenderFor | undefined;
export function setOwnerReplySenderForTests(s: SenderFor | undefined): void {
  sendersForTests = s;
}

/** The customer's channel: WhatsApp (live or dry-run by configuration), or the web chat (the message is posted to it). */
export function ownerSenderFor(conversation: ConversationState): OutboundSender {
  if (sendersForTests) return sendersForTests(conversation);
  if (conversation.id.startsWith("wa:")) {
    const wa = whatsappConfig();
    return wa.sendMode === "live" ? whatsappSender() : { channel: "whatsapp", mode: "dry_run", send: async () => ({}) };
  }
  // Web chat: the customer reads the conversation itself — posting the message IS delivering it.
  return { channel: "web", mode: "live", send: async () => ({}) };
}

function scoped(state: ConversationState | undefined, graph: BusinessGraph): ConversationState {
  if (!state || state.businessId !== graph.business.id) throw new OwnerControlError("not_found", "Conversation not found");
  return state;
}

/** The owner (or team) takes the conversation: BARRY stops replying to it; a handoff BARRY opened is acknowledged by them. Idempotent. */
export async function ownerTakeOver(graph: BusinessGraph, conversationId: string, by: string, reason = "taken over by the owner"): Promise<ConversationControl> {
  const done = await updateConversation(conversationId, (s) => takeOverBy(scoped(s, graph), by, reason));
  if (!done) throw new OwnerControlError("not_found", "Conversation not found");
  return done.result;
}

/** Give the conversation back to BARRY (closes any open handoff). Idempotent. */
export async function ownerReturnToBarry(graph: BusinessGraph, conversationId: string, by: string): Promise<ConversationControl> {
  const done = await updateConversation(conversationId, (s) => returnToBarry(scoped(s, graph), by).control);
  if (!done) throw new OwnerControlError("not_found", "Conversation not found");
  return done.result;
}

/**
 * The owner replies to the customer through BARRY's channel. Replying takes the conversation (BARRY stays
 * silent until it is returned). At most once per `requestId`.
 */
export async function ownerReply(graph: BusinessGraph, conversationId: string, input: { requestId: string; text: string; by: string }, opts: { now?: Date } = {}): Promise<OwnerReplyRecord> {
  const text = input.text.trim().slice(0, 4000);
  if (!text) throw new OwnerControlError("empty", "Write a message first");
  return withConversationLock(conversationId, async () => {
    const store = getConversationStore();
    // Never send something the store can't then record as the owner's message (fail closed, before any send).
    await store.assertOwnerMessages?.();
    const state = scoped(await store.get(conversationId), graph);
    const prior = readOwnerReplies(state)[input.requestId];
    // The same request again (a double tap, a retried request): never a second send.
    if (prior) return prior.status === "sending" ? { ...prior, status: "unknown", error: "the send was interrupted; it was not sent again" } : prior;
    const sender = ownerSenderFor(state);
    const now = opts.now ?? new Date();
    if (sender.channel === "whatsapp" && sender.mode === "live") {
      const lastCustomer = [...state.messages].reverse().find((m) => m.role === "customer")?.at;
      if (!lastCustomer || now.getTime() - Date.parse(lastCustomer) > WHATSAPP_WINDOW_MS) throw new OwnerControlError("outside_whatsapp_window", "It's been more than 24 hours since the customer last wrote, so WhatsApp only allows an approved template message. Nothing was sent.");
    }
    const at = now.toISOString();
    // 1) Persist the attempt (and take the conversation) BEFORE the channel call.
    giveToHuman(state, input.by, "the owner replied to the customer");
    writeOwnerReply(state, { requestId: input.requestId, by: input.by, text, status: "sending", at });
    await store.save(state);
    // 2) Send.
    let record: OwnerReplyRecord;
    try {
      const to = state.id.split(":").slice(2).join(":") || state.customerId;
      const sent = sender.mode === "live" ? await sender.send(to, text, { businessId: graph.business.id }) : {};
      record = { requestId: input.requestId, by: input.by, text, status: sender.mode === "live" ? "sent" : "dry_run", at, messageAt: at, ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}) };
    } catch (err) {
      record = { requestId: input.requestId, by: input.by, text, status: "failed", at, error: err instanceof Error ? err.message.slice(0, 200) : "send failed" };
    }
    // 3) Record what happened: the owner's message in the transcript (theirs, never BARRY's), the delivery,
    //    the request's outcome. A failed send is not in the transcript (the customer got nothing).
    if (record.status !== "failed") state.messages.push({ role: "owner", content: text, at, author: input.by });
    const delivery: DeliveryRecord = { at, channel: sender.channel, inboundId: `owner:${input.requestId}`, status: record.status === "sent" ? "sent" : record.status === "dry_run" ? "dry_run" : "failed", ...(record.status !== "failed" ? { messageAt: at } : {}), ...(record.providerMessageId ? { providerMessageId: record.providerMessageId } : {}), ...(record.error ? { error: record.error } : {}) };
    const deliveries = JSON.parse(state.knownFields[CHANNEL_DELIVERY_KEY] ?? "[]") as DeliveryRecord[];
    state.knownFields[CHANNEL_DELIVERY_KEY] = JSON.stringify([...deliveries, delivery].slice(-50));
    writeOwnerReply(state, record);
    await store.save(state);
    return record;
  });
}

export { readControl };
