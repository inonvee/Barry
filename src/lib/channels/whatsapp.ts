import crypto from "node:crypto";
import type { NormalizedInboundMessage } from "./types";
import type { OwnerInbound, OwnerOutbound, OwnerSender } from "@/lib/owner-channel/transport";
import { renderOwnerText } from "@/lib/owner-channel/transport";
import { conversationIdFor, type OutboundSender } from "./gateway";

/**
 * WHATSAPP (Meta WhatsApp Cloud API) channel adapter.
 *
 * Configuration (environment; names only are ever shown):
 *   WHATSAPP_VERIFY_TOKEN     the token Meta echoes during webhook setup (GET verification)
 *   WHATSAPP_APP_SECRET       signs every webhook POST (X-Hub-Signature-256) — unsigned/invalid = rejected
 *   WHATSAPP_ACCESS_TOKEN     sends replies (Graph API)
 *   BARRY_WHATSAPP_ROUTES     "<phone_number_id>=<businessId>,…" — which business a number belongs to
 *   BARRY_WHATSAPP_SEND       "live" to really send; anything else = dry run (replies recorded, nothing sent)
 *   WHATSAPP_GRAPH_VERSION    optional, default v21.0
 *   BARRY_WHATSAPP_OWNER_NUMBERS  "<phone_number_id>,…" — BARRY's OWNER line(s): messages there go to the
 *                             owner command channel, never to a customer conversation. A number that is
 *                             also routed to a business (customer line) is never treated as an owner line.
 *   BARRY_WHATSAPP_OWNER_DISPLAY  optional E.164 of the owner line, for "Open BARRY in WhatsApp" links
 * Nothing here is faked: without these, the channel reports exactly what's missing and receives nothing.
 */

export type WhatsAppConfig = {
  configured: boolean;
  missing: string[];
  sendMode: "live" | "dry_run";
  routes: Record<string, string>;
};

export function whatsappConfig(): WhatsAppConfig {
  const required = ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "BARRY_WHATSAPP_ROUTES"];
  const missing = required.filter((k) => !process.env[k]?.trim());
  const routes: Record<string, string> = {};
  for (const pair of (process.env.BARRY_WHATSAPP_ROUTES ?? "").split(",")) {
    const [phoneNumberId, businessId] = pair.split("=").map((s) => s?.trim());
    if (phoneNumberId && businessId) routes[phoneNumberId] = businessId;
  }
  return { configured: missing.length === 0 && Object.keys(routes).length > 0, missing, sendMode: process.env.BARRY_WHATSAPP_SEND === "live" ? "live" : "dry_run", routes };
}

/** BARRY's owner line(s) — distinct from every customer line (fail closed if configured as both). */
export function whatsappOwnerConfig(): { configured: boolean; numbers: string[]; sendMode: "live" | "dry_run"; display?: string } {
  const base = whatsappConfig();
  const routed = new Set(Object.keys(base.routes));
  const numbers = (process.env.BARRY_WHATSAPP_OWNER_NUMBERS ?? "").split(",").map((s) => s.trim()).filter((n) => n && !routed.has(n));
  const tokens = ["WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN"].every((k) => process.env[k]?.trim());
  const display = process.env.BARRY_WHATSAPP_OWNER_DISPLAY?.replace(/[^\d]/g, "") || undefined;
  return { configured: tokens && numbers.length > 0, numbers, sendMode: base.sendMode, ...(display ? { display } : {}) };
}

/** The phone number(s) routed to a business. */
export function whatsappNumbersFor(businessId: string): string[] {
  return Object.entries(whatsappConfig().routes)
    .filter(([, b]) => b === businessId)
    .map(([n]) => n);
}

/** GET handshake: echo the challenge only for the configured verify token. */
export function verifyWebhookSubscription(params: URLSearchParams): { ok: true; challenge: string } | { ok: false } {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!expected) return { ok: false };
  const token = params.get("hub.verify_token") ?? "";
  const same = token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  return params.get("hub.mode") === "subscribe" && same && params.get("hub.challenge") ? { ok: true, challenge: params.get("hub.challenge")! } : { ok: false };
}

/** POST authenticity: HMAC-SHA256 of the RAW body with the app secret. */
export function verifySignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"));
  const given = Buffer.from(header.slice("sha256=".length));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

type WaPayload = {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string }; interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } }; button?: { payload?: string; text?: string } }[];
        statuses?: { id?: string; status?: string; recipient_id?: string; errors?: { code?: number; title?: string }[] }[];
      };
    }[];
  }[];
};

export type ParsedInbound = NormalizedInboundMessage & { inboundId: string; profileName?: string };
export type ParsedWebhook = {
  messages: ParsedInbound[];
  /** Inbound on a number no business is routed to (reported, never processed). */
  unrouted: string[];
  /** Message types BARRY doesn't handle yet (e.g. images/voice) — reported to the owner, not guessed at. */
  unsupported: { inboundId: string; businessId: string; type: string }[];
  statuses: { providerMessageId: string; status: string; error?: string }[];
  /** Messages to BARRY's OWNER line — owner command channel only, never a customer conversation. */
  owner: OwnerInbound[];
};

/** Normalize a verified webhook payload. Pure: no I/O. */
export function parseWebhook(body: unknown, routes = whatsappConfig().routes, ownerNumbers: string[] = whatsappOwnerConfig().numbers): ParsedWebhook {
  const out: ParsedWebhook = { messages: [], unrouted: [], unsupported: [], statuses: [], owner: [] };
  const payload = body as WaPayload;
  if (payload?.object !== "whatsapp_business_account") return out;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      const phoneNumberId = change.value.metadata?.phone_number_id ?? "";
      const businessId = routes[phoneNumberId];
      for (const s of change.value.statuses ?? []) {
        if (s.id && s.status) out.statuses.push({ providerMessageId: s.id, status: s.status, ...(s.errors?.[0] ? { error: `${s.errors[0].code ?? ""} ${s.errors[0].title ?? ""}`.trim() } : {}) });
      }
      const ownerLine = !businessId && ownerNumbers.includes(phoneNumberId);
      for (const m of change.value.messages ?? []) {
        if (!m.id || !m.from) continue;
        if (ownerLine) {
          const action = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload;
          const text = m.type === "text" ? m.text?.body?.trim() : m.button?.text?.trim();
          if (!action && !text) {
            out.unsupported.push({ inboundId: m.id, businessId: "owner", type: m.type ?? "unknown" });
            continue;
          }
          out.owner.push({ channel: "whatsapp", messageId: m.id, channelUserId: m.from, verifiedIdentifier: `phone:${m.from}`, receivedAt: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(), ...(text ? { text: text.slice(0, 2000) } : {}), ...(action ? { actionId: action.slice(0, 200) } : {}) });
          continue;
        }
        if (!businessId) {
          out.unrouted.push(phoneNumberId);
          continue;
        }
        if (m.type !== "text" || !m.text?.body?.trim()) {
          out.unsupported.push({ inboundId: m.id, businessId, type: m.type ?? "unknown" });
          continue;
        }
        const profileName = change.value.contacts?.find((c) => c.wa_id === m.from)?.profile?.name;
        out.messages.push({
          inboundId: m.id,
          businessId,
          conversationId: conversationIdFor("whatsapp", businessId, m.from),
          customerId: `wa:${m.from}`,
          identity: { channel: "whatsapp", channelUserId: m.from, verifiedIdentifier: `phone:${m.from}` },
          text: m.text.body.slice(0, 4000),
          receivedAt: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
          ...(profileName ? { profileName } : {}),
        });
      }
    }
  }
  return out;
}

/** Sends a text reply through the Graph API — only in live mode, only with a routed number. */
export function whatsappSender(fetchImpl: typeof fetch = fetch): OutboundSender {
  const cfg = whatsappConfig();
  return {
    channel: "whatsapp",
    mode: cfg.sendMode,
    async send(to, text, context) {
      const phoneNumberId = Object.entries(cfg.routes).find(([, b]) => b === context.businessId)?.[0];
      const token = process.env.WHATSAPP_ACCESS_TOKEN;
      if (!phoneNumberId || !token) throw new Error("WhatsApp sending is not configured for this business");
      const version = process.env.WHATSAPP_GRAPH_VERSION || "v21.0";
      const res = await fetchImpl(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 4096), preview_url: false } }),
      });
      const data = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[]; error?: { message?: string; code?: number } };
      if (!res.ok) throw new Error(`WhatsApp send failed (${res.status}${data.error?.code ? ` / ${data.error.code}` : ""})`);
      return { providerMessageId: data.messages?.[0]?.id };
    },
  };
}

/**
 * The owner line's sender: text, or interactive reply buttons (max 3, titles ≤ 20 chars) when the reply
 * carries actions. Live only in BARRY_WHATSAPP_SEND=live; otherwise a dry run (recorded, nothing sent).
 */
export function whatsappOwnerSender(fetchImpl: typeof fetch = fetch): OwnerSender {
  const cfg = whatsappOwnerConfig();
  return {
    channel: "whatsapp",
    mode: cfg.sendMode,
    async send(to: string, message: OwnerOutbound) {
      const phoneNumberId = cfg.numbers[0];
      const token = process.env.WHATSAPP_ACCESS_TOKEN;
      if (!phoneNumberId || !token) throw new Error("The BARRY owner line is not configured");
      const version = process.env.WHATSAPP_GRAPH_VERSION || "v21.0";
      const actions = (message.actions ?? []).slice(0, 3);
      const body = actions.length
        ? { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", body: { text: renderOwnerText({ text: message.text, links: message.links }).slice(0, 1024) }, action: { buttons: actions.map((a) => ({ type: "reply", reply: { id: a.id.slice(0, 256), title: a.title.slice(0, 20) } })) } } }
        : { messaging_product: "whatsapp", to, type: "text", text: { body: renderOwnerText(message).slice(0, 4096), preview_url: false } };
      const res = await fetchImpl(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[]; error?: { code?: number } };
      if (!res.ok) throw new Error(`WhatsApp send failed (${res.status}${data.error?.code ? ` / ${data.error.code}` : ""})`);
      return { providerMessageId: data.messages?.[0]?.id };
    },
  };
}
