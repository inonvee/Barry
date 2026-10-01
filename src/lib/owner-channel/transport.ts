/**
 * OWNER CHANNEL TRANSPORT — the provider-neutral contract between a messaging channel and the owner
 * command runtime. Adapters (WhatsApp today; SMS, Slack, Telegram, voice, native apps later) only:
 *   - verify and normalize an inbound owner message (text, or a tapped action),
 *   - render and deliver an OwnerOutbound (text + up to three actions + links).
 * Identity, business binding, interpretation, operations, authority and execution never live here.
 */

export type OwnerChannel = "whatsapp";

export type OwnerInbound = {
  channel: OwnerChannel;
  /** The provider's message id — the idempotency key for this inbound. */
  messageId: string;
  channelUserId: string;
  /** What the provider verified about the sender (e.g. "phone:972…"); absent = unverified. */
  verifiedIdentifier?: string;
  receivedAt: string;
  text?: string;
  /** A tapped action (button / list reply): the opaque id BARRY sent. */
  actionId?: string;
};

/** A reply action. `id` is opaque and resolved server-side against a stored, single-use prompt. */
export type OwnerAction = { id: string; title: string };

export type OwnerOutbound = { text: string; actions?: OwnerAction[]; links?: { label: string; href: string }[] };

export interface OwnerSender {
  readonly channel: OwnerChannel;
  /** "live" sends for real; "dry_run" records what would have been sent and sends nothing. */
  readonly mode: "live" | "dry_run";
  send(to: string, message: OwnerOutbound): Promise<{ providerMessageId?: string }>;
}

/** Plain-text rendering for channels without buttons: actions become "Reply …" lines; links are listed. */
export function renderOwnerText(m: OwnerOutbound, opts: { actionsAsText?: boolean } = {}): string {
  const parts = [m.text.trim()];
  if (opts.actionsAsText && m.actions?.length) parts.push(m.actions.map((a) => `Reply “${a.title}”`).join(" · "));
  for (const l of m.links ?? []) parts.push(`${l.label}: ${l.href}`);
  return parts.filter(Boolean).join("\n\n");
}

/** Records every owner reply that left (or would have left) BARRY. */
export type OwnerDelivery = { at: string; channel: OwnerChannel; to: string; status: "sent" | "dry_run" | "failed" | "blocked"; providerMessageId?: string; error?: string; reason?: string };

export async function deliverOwner(sender: OwnerSender, to: string, message: OwnerOutbound, now = new Date()): Promise<OwnerDelivery> {
  const at = now.toISOString();
  const masked = `···${to.slice(-4)}`;
  if (sender.mode !== "live") return { at, channel: sender.channel, to: masked, status: "dry_run" };
  try {
    const sent = await sender.send(to, message);
    return { at, channel: sender.channel, to: masked, status: "sent", ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}) };
  } catch (err) {
    return { at, channel: sender.channel, to: masked, status: "failed", error: err instanceof Error ? err.message.slice(0, 200) : "send failed" };
  }
}
