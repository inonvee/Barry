import crypto from "node:crypto";
import type { NormalizedInboundMessage } from "./types";
import type { OwnerInbound, OwnerOutbound, OwnerSender } from "@/lib/owner-channel/transport";
import { renderOwnerText } from "@/lib/owner-channel/transport";
import { conversationIdFor, type OutboundSender } from "./gateway";
import { mediaPlaceholder } from "./media";

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

/**
 * BARRY's FOUNDER line(s) (BARRY_WHATSAPP_FOUNDER_NUMBERS: phone_number_ids) — the founder command channel. Distinct
 * from every customer line AND every owner line: a number configured as either is never a founder line (fail closed).
 *
 * Its send mode is its OWN: BARRY_WHATSAPP_FOUNDER_SEND=live makes founder replies live while customer and owner lines
 * keep following BARRY_WHATSAPP_SEND (dry run by default). Anything but exactly "live" is dry run. It never widens the
 * other lines: neither whatsappConfig() nor whatsappOwnerConfig() reads it.
 */
export function whatsappFounderConfig(): { configured: boolean; numbers: string[]; sendMode: "live" | "dry_run" } {
  const base = whatsappConfig();
  const taken = new Set([...Object.keys(base.routes), ...whatsappOwnerConfig().numbers, ...(process.env.BARRY_WHATSAPP_OWNER_NUMBERS ?? "").split(",").map((x) => x.trim())]);
  const numbers = (process.env.BARRY_WHATSAPP_FOUNDER_NUMBERS ?? "").split(",").map((x) => x.trim()).filter((n) => n && !taken.has(n));
  const tokens = ["WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN"].every((k) => process.env[k]?.trim());
  return { configured: tokens && numbers.length > 0, numbers, sendMode: process.env.BARRY_WHATSAPP_FOUNDER_SEND?.trim() === "live" ? "live" : "dry_run" };
}

/**
 * IDENTITY ROLE ROUTING on BARRY's routed number(s) — one WhatsApp number serves every role.
 * BARRY_WHATSAPP_ROLE_ROUTING=identity: a message to a routed (customer) line goes to Founder BARRY when the sender is
 * a verified, ACTIVE founder link (or redeems a valid HQ founder code), to Owner BARRY when the sender is a verified,
 * active owner link of THAT line's business (or redeems a valid owner code for it), and to the customer flow
 * otherwise. Never inferred from what the message says. Anything else (unset / other values) = off: routed lines are
 * customer lines only, exactly as before.
 */
export function whatsappRoleRouting(): "identity" | "off" {
  return process.env.BARRY_WHATSAPP_ROLE_ROUTING?.trim() === "identity" ? "identity" : "off";
}

/** The three outbound send modes, separately (startup / preflight status; never a secret). */
export function whatsappSendModes(): { customer: "live" | "dry_run"; owner: "live" | "dry_run"; founder: "live" | "dry_run"; ownerLine: "configured" | "not configured"; founderLine: "configured" | "not configured"; roleRouting: "identity" | "off" } {
  const owner = whatsappOwnerConfig();
  const founder = whatsappFounderConfig();
  return { customer: whatsappConfig().sendMode, owner: owner.sendMode, founder: founder.sendMode, ownerLine: owner.configured ? "configured" : "not configured", founderLine: founder.configured ? "configured" : "not configured", roleRouting: whatsappRoleRouting() };
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
        messages?: { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string }; image?: { caption?: string }; video?: { caption?: string }; document?: { caption?: string; filename?: string }; interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } }; button?: { payload?: string; text?: string } }[];
        statuses?: { id?: string; status?: string; recipient_id?: string; errors?: { code?: number; title?: string }[] }[];
      };
    }[];
  }[];
};

export type ParsedInbound = NormalizedInboundMessage & {
  inboundId: string;
  profileName?: string;
  /** The receiving phone_number_id (replies to a verified founder / owner go back from the same line). */
  lineId?: string;
  /** Role-neutral content (text, or a tapped button id) — used ONLY when the sender proves to be a verified founder
   *  or owner of this business (identity role routing); a customer turn never reads it. */
  command?: { text?: string; actionId?: string };
};
export type ParsedWebhook = {
  messages: ParsedInbound[];
  /** Inbound on a number no business is routed to (reported, never processed). */
  unrouted: string[];
  /** Messages ignored on purpose (reactions, unknown owner-line types) — logged only. Media a customer sends
   *  (voice, image, file…) is NOT here: it is a message with `media` set, kept and answered honestly. */
  unsupported: { inboundId: string; businessId: string; type: string }[];
  statuses: { providerMessageId: string; status: string; error?: string }[];
  /** Messages to BARRY's OWNER line — owner command channel only, never a customer conversation. */
  owner: OwnerInbound[];
  /** Messages to BARRY's FOUNDER line — the founder command channel only (never a customer or owner path). */
  founder: OwnerInbound[];
};

/** Normalize a verified webhook payload. Pure: no I/O. */
export function parseWebhook(body: unknown, routes = whatsappConfig().routes, ownerNumbers: string[] = whatsappOwnerConfig().numbers, founderNumbers: string[] = whatsappFounderConfig().numbers): ParsedWebhook {
  const out: ParsedWebhook = { messages: [], unrouted: [], unsupported: [], statuses: [], owner: [], founder: [] };
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
      // A founder line is never also a customer or owner line (checked here too, not only in the config).
      const founderLine = !businessId && !ownerLine && founderNumbers.includes(phoneNumberId);
      for (const m of change.value.messages ?? []) {
        if (!m.id || !m.from) continue;
        if (ownerLine || founderLine) {
          const action = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload;
          const text = m.type === "text" ? m.text?.body?.trim() : m.button?.text?.trim();
          if (!action && !text) {
            out.unsupported.push({ inboundId: m.id, businessId: founderLine ? "founder" : "owner", type: m.type ?? "unknown" });
            continue;
          }
          (founderLine ? out.founder : out.owner).push({ channel: "whatsapp", messageId: m.id, channelUserId: m.from, verifiedIdentifier: `phone:${m.from}`, receivedAt: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(), ...(text ? { text: text.slice(0, 2000) } : {}), ...(action ? { actionId: action.slice(0, 200) } : {}) });
          continue;
        }
        if (!businessId) {
          out.unrouted.push(phoneNumberId);
          continue;
        }
        const profileName = change.value.contacts?.find((c) => c.wa_id === m.from)?.profile?.name;
        if (m.type !== "text" || !m.text?.body?.trim()) {
          // A reaction is not a message to answer.
          if (m.type === "reaction" || (m.type === "text" && !m.text?.body?.trim())) {
            out.unsupported.push({ inboundId: m.id, businessId, type: m.type ?? "unknown" });
            continue;
          }
          // Media BARRY can't read: kept as a message (placeholder + the customer's caption), answered honestly.
          const type = m.type ?? "unknown";
          const caption = (m.image?.caption ?? m.video?.caption ?? m.document?.caption)?.trim().slice(0, 1000) || undefined;
          const action = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload;
          const buttonText = m.button?.text?.trim();
          out.messages.push({
            lineId: phoneNumberId,
            ...(action || buttonText ? { command: { ...(buttonText ? { text: buttonText.slice(0, 2000) } : {}), ...(action ? { actionId: action.slice(0, 200) } : {}) } } : {}),
            inboundId: m.id,
            businessId,
            conversationId: conversationIdFor("whatsapp", businessId, m.from),
            customerId: `wa:${m.from}`,
            identity: { channel: "whatsapp", channelUserId: m.from, verifiedIdentifier: `phone:${m.from}` },
            text: mediaPlaceholder(type, caption),
            media: { type, ...(caption ? { caption } : {}) },
            receivedAt: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
            ...(profileName ? { profileName } : {}),
          });
          continue;
        }
        out.messages.push({
          lineId: phoneNumberId,
          command: { text: m.text.body.trim().slice(0, 2000) },
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
export function whatsappOwnerSender(fetchImpl: typeof fetch = fetch, lineId?: string): OwnerSender {
  const cfg = whatsappOwnerConfig();
  return lineSender(lineId ? { ...cfg, numbers: [lineId] } : cfg, "owner", fetchImpl);
}

/**
 * The founder's sender — its OWN send mode (BARRY_WHATSAPP_FOUNDER_SEND), from the founder line, or (identity role
 * routing) from the shared line the verified founder wrote to. The mode comes from the ROLE, never from the line.
 */
export function whatsappFounderSender(fetchImpl: typeof fetch = fetch, lineId?: string): OwnerSender {
  const cfg = whatsappFounderConfig();
  return lineSender(lineId ? { ...cfg, numbers: [lineId] } : cfg, "founder", fetchImpl);
}

function lineSender(cfg: { numbers: string[]; sendMode: "live" | "dry_run" }, line: "owner" | "founder", fetchImpl: typeof fetch): OwnerSender {
  return {
    channel: "whatsapp",
    mode: cfg.sendMode,
    async send(to: string, message: OwnerOutbound) {
      const phoneNumberId = cfg.numbers[0];
      const token = process.env.WHATSAPP_ACCESS_TOKEN;
      if (!phoneNumberId || !token) throw new Error(`The BARRY ${line} line is not configured`);
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
