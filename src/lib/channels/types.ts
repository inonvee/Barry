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
  /** Something BARRY can't read (voice note, image, file…): `text` is a placeholder; never sent to a model. */
  media?: { type: string; caption?: string };
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
      /** The exact variant this card is about (e.g. "M · black"), when one was resolved. */
      variant?: string;
    }[];
    paymentUrl?: string;
    media?: { url: string; alt?: string }[];
    /** Calls to action the channel renders as buttons or links. */
    cta?: { kind: "pay" | "view" | "book" | "track"; label: string; url: string }[];
    /** Provider-grounded order / payment status, when the reply is about one. */
    order?: { label: string; reference: string; status: string; eta?: string };
    payment?: { label: string; status: "pending" | "paid" | "failed" | "cancelled"; amount?: string };
  };
};

export interface ChannelAdapter {
  readonly channel: ChannelKind;
  normalizeInbound(raw: unknown): Promise<NormalizedInboundMessage>;
  send(message: NormalizedOutboundMessage): Promise<{ providerMessageId?: string }>;
}

/** Web sessions carry no verified identifier; WhatsApp numbers are verified by the provider. */
export function identityVerification(identity: ChannelIdentity): "verified" | "unverified" {
  return identity.verifiedIdentifier ? "verified" : "unverified";
}

export function canLinkIdentities(a: ChannelIdentity, b: ChannelIdentity): boolean {
  return Boolean(a.verifiedIdentifier && b.verifiedIdentifier && a.verifiedIdentifier === b.verifiedIdentifier);
}
