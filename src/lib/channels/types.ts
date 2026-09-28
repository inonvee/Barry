export type ChannelKind = "web" | "whatsapp" | "instagram";

export type ChannelIdentity = {
  channel: ChannelKind;
  channelUserId: string;
  verifiedIdentifier?: string;
};

export type NormalizedInboundMessage = {
  businessId: string;
  conversationId: string;
  customerId?: string;
  identity: ChannelIdentity;
  text: string;
  receivedAt: string;
  attachments?: { type: "image" | "video" | "document"; url: string; contentType?: string }[];
};

export type NormalizedOutboundMessage = {
  conversationId: string;
  text: string;
  rich?: {
    products?: {
      title: string;
      imageUrl?: string;
      price?: string;
      url?: string;
      availability?: string;
    }[];
    paymentUrl?: string;
    media?: { url: string; alt?: string }[];
  };
};

export interface ChannelAdapter {
  readonly channel: ChannelKind;
  normalizeInbound(raw: unknown): Promise<NormalizedInboundMessage>;
  send(message: NormalizedOutboundMessage): Promise<{ providerMessageId?: string }>;
}

export function canLinkIdentities(a: ChannelIdentity, b: ChannelIdentity): boolean {
  return Boolean(a.verifiedIdentifier && b.verifiedIdentifier && a.verifiedIdentifier === b.verifiedIdentifier);
}
