import { channelDisabled, loadControls } from "@/lib/hq/controls";
import { renderRichText } from "./rich";
import { resolveCustomerIdentity } from "./identity";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { handleCustomerMessage } from "@/lib/runtime";
import { getConversationStore } from "@/lib/state";
import type { ChannelKind, NormalizedInboundMessage, NormalizedOutboundMessage } from "./types";

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
  status: "sent" | "dry_run" | "failed";
  providerMessageId?: string;
  error?: string;
};

export const CHANNEL_SEEN_KEY = "__channelSeen";
export const CHANNEL_DELIVERY_KEY = "__channelDelivery";
export const CHANNEL_PROFILE_KEY = "__channelProfileName";
const MAX_SEEN = 200;
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
  | { status: "failed"; conversationId: string; error: string };

/** Process one normalized inbound message end to end. */
export async function processInbound(message: NormalizedInboundMessage & { inboundId: string; profileName?: string }, sender: OutboundSender): Promise<InboundResult> {
  const graph = resolveBusinessGraph(message.businessId);
  // A channel the founder disabled is not answered on: nothing is processed, nothing is sent.
  const controls = await loadControls(graph.business.id);
  if (channelDisabled(controls, message.identity.channel)) {
    return { status: "failed", conversationId: message.conversationId, error: `channel ${message.identity.channel} is disabled by the founder` };
  }
  const store = getConversationStore();
  // Verified cross-channel identity: a linked identity resolves to its canonical customer; never by name.
  const resolved = await resolveCustomerIdentity(graph.business.id, message.identity);
  const customerId = resolved.linked ? resolved.customerId : message.customerId ?? resolved.customerId;
  const conversationId = message.conversationId;
  const state = await store.getOrCreate(conversationId, graph.business.id, customerId);
  const seen = readList<string>(state.knownFields[CHANNEL_SEEN_KEY]);
  if (seen.includes(message.inboundId)) return { status: "duplicate", conversationId };
  // Marked seen before anything runs: at-most-once processing of a customer message.
  state.knownFields[CHANNEL_SEEN_KEY] = JSON.stringify([...seen, message.inboundId].slice(-MAX_SEEN));
  if (message.profileName && !state.knownFields[CHANNEL_PROFILE_KEY]) state.knownFields[CHANNEL_PROFILE_KEY] = message.profileName.slice(0, 80);
  await store.save(state);

  let reply: string;
  let rich: NormalizedOutboundMessage["rich"];
  try {
    const out = await handleCustomerMessage(graph, conversationId, customerId, message.text);
    reply = out.response;
    rich = out.rich;
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 200) : "runtime error";
    console.error("[barry:channel] inbound processing failed", { channel: message.identity.channel, conversationId, error });
    await recordDelivery(conversationId, { at: new Date().toISOString(), channel: message.identity.channel, inboundId: message.inboundId, status: "failed", error: `not processed: ${error}` });
    return { status: "failed", conversationId, error };
  }

  const text = renderForTextChannel({ conversationId, text: reply, rich });
  let delivery: DeliveryRecord;
  try {
    const sent = sender.mode === "live" ? await sender.send(message.identity.channelUserId, text, { businessId: graph.business.id }) : {};
    delivery = { at: new Date().toISOString(), channel: sender.channel, inboundId: message.inboundId, status: sender.mode === "live" ? "sent" : "dry_run", ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}) };
  } catch (err) {
    delivery = { at: new Date().toISOString(), channel: sender.channel, inboundId: message.inboundId, status: "failed", error: err instanceof Error ? err.message.slice(0, 200) : "send failed" };
  }
  await recordDelivery(conversationId, delivery);
  return { status: "processed", conversationId, reply: text, delivery };
}

async function recordDelivery(conversationId: string, d: DeliveryRecord): Promise<void> {
  const store = getConversationStore();
  const state = await store.get(conversationId);
  if (!state) return;
  state.knownFields[CHANNEL_DELIVERY_KEY] = JSON.stringify([...readList<DeliveryRecord>(state.knownFields[CHANNEL_DELIVERY_KEY]), d].slice(-MAX_DELIVERY));
  await store.save(state);
}

export function readDeliveries(knownFields: Record<string, string>): DeliveryRecord[] {
  return readList<DeliveryRecord>(knownFields[CHANNEL_DELIVERY_KEY]);
}
