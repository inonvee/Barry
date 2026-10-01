import type { NextRequest } from "next/server";
import { parseWebhook, verifySignature, verifyWebhookSubscription, whatsappConfig, whatsappOwnerConfig, whatsappOwnerSender, whatsappSender } from "@/lib/channels/whatsapp";
import { processInbound } from "@/lib/channels/gateway";
import { processOwnerInbound } from "@/lib/owner-channel/gateway";
import { notifyOwnerDecisions } from "@/lib/owner/briefs";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";

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
  const owner = whatsappOwnerConfig();
  if (!cfg.configured && !owner.configured) return Response.json({ error: "WhatsApp channel is not configured" }, { status: 503 });
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
  // Owner line: the owner command channel (never a customer conversation).
  const ownerResults = [];
  for (const m of parsed.owner) ownerResults.push(await processOwnerInbound(m, whatsappOwnerSender()).catch((err) => ({ status: "failed" as const, error: err instanceof Error ? err.message.slice(0, 120) : "error" })));
  // A customer turn may have created a request for the owner: announce it once on the owner line.
  for (const businessId of new Set(parsed.messages.map((m) => m.businessId))) await notifyOwnerDecisions(resolveBusinessGraph(businessId)).catch((err) => console.warn("[barry:owner-brief] decision notice failed", err instanceof Error ? err.message : err));
  if (parsed.unrouted.length) console.warn("[barry:whatsapp] message for an unrouted number", { count: parsed.unrouted.length });
  if (parsed.unsupported.length) console.warn("[barry:whatsapp] unsupported message types", parsed.unsupported.map((u) => u.type));
  for (const s of parsed.statuses) if (s.status === "failed") console.warn("[barry:whatsapp] delivery failed", { error: s.error });
  // Always acknowledge a verified delivery (Meta retries otherwise); failures are recorded per conversation.
  return Response.json({ received: parsed.messages.length, processed: results.filter((r) => r.status === "processed").length, duplicates: results.filter((r) => r.status === "duplicate").length, owner: ownerResults.map((r) => r.status) });
}
