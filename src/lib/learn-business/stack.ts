import type { Capability } from "@/lib/capabilities/model";

/**
 * LEARN STACK: which systems does the business ALREADY run? BARRY adapts
 * to the business's stack instead of asking it to move — so onboarding
 * looks for the fingerprints those systems leave in a page's HTML (asset
 * hosts, embed scripts, share links). These are technical signatures, not
 * language understanding, and every detection carries the exact snippet
 * it was found in. A detection is an INFERENCE until the owner confirms
 * it; it never connects anything by itself.
 */

export type StackSignal = {
  capability: Capability;
  /** Stable key suffix, e.g. "whatsapp" for messaging channels. */
  slot: string;
  platform: string;
  /** Exact snippet of the page the fingerprint was found in. */
  evidence: string;
};

type Fingerprint = { capability: Capability; slot: string; platform: string; patterns: RegExp[] };

const FINGERPRINTS: Fingerprint[] = [
  // Commerce platforms
  { capability: "commerce", slot: "platform", platform: "Shopify", patterns: [/cdn\.shopify\.com/i, /[a-z0-9-]+\.myshopify\.com/i, /Shopify\.theme/] },
  { capability: "commerce", slot: "platform", platform: "WooCommerce", patterns: [/wp-content\/plugins\/woocommerce/i, /\bwoocommerce-(?:page|cart|checkout)\b/i] },
  { capability: "commerce", slot: "platform", platform: "Wix", patterns: [/static\.wixstatic\.com/i, /static\.parastorage\.com/i] },
  { capability: "commerce", slot: "platform", platform: "Squarespace", patterns: [/static1\.squarespace\.com/i] },
  { capability: "commerce", slot: "platform", platform: "BigCommerce", patterns: [/cdn\d*\.bigcommerce\.com/i] },
  // Payments
  { capability: "payments", slot: "provider", platform: "Stripe", patterns: [/js\.stripe\.com/i] },
  { capability: "payments", slot: "provider", platform: "PayPal", patterns: [/paypal\.com\/sdk\/js/i, /paypalobjects\.com/i] },
  { capability: "payments", slot: "provider", platform: "PayPlus", patterns: [/payplus\.co\.il/i] },
  { capability: "payments", slot: "provider", platform: "Tranzila", patterns: [/tranzila\.com/i] },
  { capability: "payments", slot: "provider", platform: "Cardcom", patterns: [/cardcom\.(?:co\.il|solutions)/i] },
  // Scheduling
  { capability: "scheduling", slot: "provider", platform: "Calendly", patterns: [/calendly\.com\/[a-z0-9_-]+/i] },
  { capability: "scheduling", slot: "provider", platform: "Google Calendar appointments", patterns: [/calendar\.google\.com\/calendar\/appointments/i] },
  { capability: "scheduling", slot: "provider", platform: "Acuity Scheduling", patterns: [/acuityscheduling\.com/i] },
  { capability: "scheduling", slot: "provider", platform: "SimplyBook.me", patterns: [/simplybook\.me/i] },
  // Customer channels
  { capability: "messaging", slot: "whatsapp", platform: "WhatsApp", patterns: [/wa\.me\/\+?\d{6,15}/i, /api\.whatsapp\.com\/send/i] },
  { capability: "messaging", slot: "instagram", platform: "Instagram", patterns: [/instagram\.com\/[a-z0-9_.]{2,30}/i] },
  { capability: "messaging", slot: "messenger", platform: "Facebook Messenger", patterns: [/\bm\.me\/[a-z0-9.]{2,50}/i] },
];

function snippet(html: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  return html
    .slice(start, index + length + 20)
    .replace(/\s+/g, " ")
    .trim();
}

/** Detect the business's existing systems from a fetched page's raw HTML. One signal per capability slot. */
export function detectStack(rawHtml: string): StackSignal[] {
  const found = new Map<string, StackSignal>();
  for (const fp of FINGERPRINTS) {
    const key = `${fp.capability}.${fp.slot}`;
    if (found.has(key)) continue;
    for (const pattern of fp.patterns) {
      const match = pattern.exec(rawHtml);
      if (match) {
        found.set(key, { capability: fp.capability, slot: fp.slot, platform: fp.platform, evidence: snippet(rawHtml, match.index, match[0].length) });
        break;
      }
    }
  }
  return [...found.values()];
}

export function stackFactKey(signal: Pick<StackSignal, "capability" | "slot">): string {
  return `stack.${signal.capability}.${signal.slot}`;
}
