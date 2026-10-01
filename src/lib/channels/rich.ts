import type { NormalizedOutboundMessage } from "./types";

/**
 * RICH COMMERCE REPLIES — one provider-independent model for product cards (title, media, price,
 * variant, availability, link), calls to action (pay / view / book), order and payment status. Built
 * only from verified tool output; adapters render it for their channel (text channels get a plain
 * rendering, never raw Markdown). Pure.
 */

export type RichReply = NonNullable<NormalizedOutboundMessage["rich"]>;

/** Markdown that must never leak into a text channel: emphasis, headings, code fences, link syntax. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*\n?/g, ""))
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, "$1$2")
    .replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, "$1$2")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 $2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

/** Plain-text rendering for channels without cards (WhatsApp text, SMS). */
export function renderRichText(out: NormalizedOutboundMessage): string {
  const parts = [stripMarkdown(out.text)];
  for (const p of out.rich?.products ?? []) {
    const line = `• ${p.title}${p.variant ? ` (${p.variant})` : ""}${p.price ? ` — ${p.price}` : ""}${p.availability ? ` · ${p.availability}` : ""}`;
    if (out.text.includes(p.title)) {
      if (p.url) parts.push(p.url);
    } else parts.push(`${line}${p.url ? `\n  ${p.url}` : ""}`);
  }
  for (const c of out.rich?.cta ?? []) parts.push(`${c.label}: ${c.url}`);
  if (out.rich?.paymentUrl && !(out.rich.cta ?? []).some((c) => c.url === out.rich?.paymentUrl)) parts.push(out.rich.paymentUrl);
  if (out.rich?.order) parts.push(`${out.rich.order.label}: ${out.rich.order.status}${out.rich.order.eta ? ` · ${out.rich.order.eta}` : ""}`);
  if (out.rich?.payment) parts.push(`${out.rich.payment.label}: ${out.rich.payment.status}`);
  return parts.join("\n");
}

/** Card-capable channels (web, future Instagram generic templates) get the structure as is. */
export function renderRichCards(out: NormalizedOutboundMessage): { text: string; cards: RichReply["products"]; cta: RichReply["cta"]; media: RichReply["media"]; order?: RichReply["order"]; payment?: RichReply["payment"] } {
  return { text: stripMarkdown(out.text), cards: out.rich?.products ?? [], cta: out.rich?.cta ?? [], media: out.rich?.media ?? [], ...(out.rich?.order ? { order: out.rich.order } : {}), ...(out.rich?.payment ? { payment: out.rich.payment } : {}) };
}
