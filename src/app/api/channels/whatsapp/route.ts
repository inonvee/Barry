import type { NextRequest } from "next/server";
import { parseWebhook, verifySignature, verifyWebhookSubscription, whatsappConfig, whatsappSender } from "@/lib/channels/whatsapp";
import { processInbound } from "@/lib/channels/gateway";

/**
 * WhatsApp Cloud API webhook. GET = Meta's subscription handshake; POST = signed events.
 * Unsigned or wrongly signed POSTs are rejected before anything is parsed. Replies are sent only
 * when BARRY_WHATSAPP_SEND=live; otherwise they are recorded as dry runs.
 */
export async function GET(req: NextRequest) {
  const v = verifyWebhookSubscription(req.nextUrl.searchParams);
  return v.ok ? new Response(v.challenge, { status: 200, headers: { "content-type": "text/plain" } }) : new Response("Forbidden", { status: 403 });
}

export async function POST(req: NextRequest) {
  const cfg = whatsappConfig();
  if (!cfg.configured) return Response.json({ error: "WhatsApp channel is not configured" }, { status: 503 });
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"))) return Response.json({ error: "Invalid signature" }, { status: 401 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }
  const parsed = parseWebhook(body, cfg.routes);
  const sender = whatsappSender();
  const results = [];
  for (const message of parsed.messages) results.push(await processInbound(message, sender));
  if (parsed.unrouted.length) console.warn("[barry:whatsapp] message for an unrouted number", { count: parsed.unrouted.length });
  if (parsed.unsupported.length) console.warn("[barry:whatsapp] unsupported message types", parsed.unsupported.map((u) => u.type));
  for (const s of parsed.statuses) if (s.status === "failed") console.warn("[barry:whatsapp] delivery failed", { error: s.error });
  // Always acknowledge a verified delivery (Meta retries otherwise); failures are recorded per conversation.
  return Response.json({ received: parsed.messages.length, processed: results.filter((r) => r.status === "processed").length, duplicates: results.filter((r) => r.status === "duplicate").length });
}
