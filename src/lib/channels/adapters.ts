import type { ChannelAdapter, ChannelKind, NormalizedInboundMessage, NormalizedOutboundMessage } from "./types";
import { parseWebhook, whatsappSender } from "./whatsapp";
import { renderRichText } from "./rich";

/**
 * CHANNEL ADAPTER REGISTRY — web, WhatsApp and (future) Instagram share ONE runtime contract. The
 * adapter owns identity normalization, rich-payload conversion, delivery and the provider receipt;
 * the runtime never knows which channel it is talking to.
 */

const adapters = new Map<ChannelKind, ChannelAdapter>();

export function registerChannelAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.channel, adapter);
}

export function getChannelAdapter(channel: ChannelKind): ChannelAdapter | undefined {
  return adapters.get(channel);
}

export function listChannelAdapters(): { channel: ChannelKind; configured: boolean }[] {
  return (["web", "whatsapp", "instagram"] as ChannelKind[]).map((channel) => ({ channel, configured: adapters.has(channel) }));
}

/** Web: identity comes from the signed-in session (unverified); replies are returned to the caller, not sent. */
registerChannelAdapter({
  channel: "web",
  async normalizeInbound(raw: unknown): Promise<NormalizedInboundMessage> {
    const r = raw as { businessId: string; conversationId: string; customerId?: string; sessionId: string; text: string };
    return { businessId: r.businessId, conversationId: r.conversationId, customerId: r.customerId, identity: { channel: "web", channelUserId: r.sessionId }, text: r.text, receivedAt: new Date().toISOString() };
  },
  async send(): Promise<{ providerMessageId?: string }> {
    return {};
  },
});

/** WhatsApp: verified webhook payloads; text rendering of rich replies; Graph API receipt. */
registerChannelAdapter({
  channel: "whatsapp",
  async normalizeInbound(raw: unknown): Promise<NormalizedInboundMessage> {
    const parsed = parseWebhook(raw);
    const first = parsed.messages[0];
    if (!first) throw new Error("no routed text message in the payload");
    return first;
  },
  async send(message: NormalizedOutboundMessage): Promise<{ providerMessageId?: string }> {
    const to = message.conversationId.split(":")[2];
    const businessId = message.conversationId.split(":")[1];
    return whatsappSender().send(to, renderRichText(message), { businessId });
  },
});
