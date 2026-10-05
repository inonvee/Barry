import type { NextRequest } from "next/server";
import { parseWebhook, verifySignature, verifyWebhookSubscription, whatsappConfig, whatsappFounderConfig, whatsappFounderSender, whatsappOwnerConfig, whatsappOwnerSender, whatsappSendModes } from "@/lib/channels/whatsapp";
import { processFounderInbound } from "@/lib/founder-channel/gateway";
import { asCommandInbound, classifySender, roleSenders } from "@/lib/channels/role-routing";
import { whatsappRoleRouting, type ParsedInbound } from "@/lib/channels/whatsapp";
import { processInbound } from "@/lib/channels/gateway";
import { arrivalClock } from "@/lib/channels/inbox";
import { processOwnerInbound } from "@/lib/owner-channel/gateway";
import { notifyOwnerAlert, notifyOwnerAttention, notifyOwnerDecisions } from "@/lib/owner/briefs";
import { mediaAlertText } from "@/lib/channels/media";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";

/**
 * WhatsApp Cloud API webhook. GET = Meta's subscription handshake; POST = signed events.
 * Unsigned or wrongly signed POSTs are rejected before anything is parsed. Replies are sent only
 * when BARRY_WHATSAPP_SEND=live; otherwise they are recorded as dry runs.
 */
// Startup status: the three send modes, separately (no secrets) — once per server instance.
console.info("[barry:whatsapp] send modes", whatsappSendModes());

export async function GET(req: NextRequest) {
  const v = verifyWebhookSubscription(req.nextUrl.searchParams);
  return v.ok ? new Response(v.challenge, { status: 200, headers: { "content-type": "text/plain" } }) : new Response("Forbidden", { status: 403 });
}

export async function POST(req: NextRequest) {
  // When this request reached BARRY — taken before any await, so concurrent deliveries keep their arrival order.
  const arrivedAt = arrivalClock();
  const cfg = whatsappConfig();
  const owner = whatsappOwnerConfig();
  if (!cfg.configured && !owner.configured && !whatsappFounderConfig().configured) return Response.json({ error: "WhatsApp channel is not configured" }, { status: 503 });
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"))) return Response.json({ error: "Invalid signature" }, { status: 401 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }
  const parsed = parseWebhook(body, cfg.routes);
  // SINGLE-NUMBER ROLE ROUTING (BARRY_WHATSAPP_ROLE_ROUTING=identity): the VERIFIED SENDER decides — founder link →
  // Founder BARRY, owner link of this line's business → Owner BARRY, everyone else → the customer flow. Each role
  // replies with its OWN sender (founder: BARRY_WHATSAPP_FOUNDER_SEND; owner / customer: BARRY_WHATSAPP_SEND).
  const customerMessages: ParsedInbound[] = [];
  const roleResults: { role: "founder" | "owner"; status: string }[] = [];
  for (const m of parsed.messages) {
    const role = whatsappRoleRouting() === "identity" ? await classifySender(m).catch(() => "customer" as const) : "customer";
    if (role === "founder") {
      const result = await processFounderInbound(asCommandInbound(m), roleSenders.founder(m.lineId), { lineId: m.lineId }).catch((err) => ({ status: `failed: ${err instanceof Error ? err.message.slice(0, 80) : "error"}` }));
      if ("delivery" in result && result.delivery?.status === "failed") console.warn("[barry:whatsapp] founder reply delivery failed", { error: result.delivery.error });
      roleResults.push({ role, status: result.status });
    }
    else if (role === "owner") roleResults.push({ role, status: (await processOwnerInbound(asCommandInbound(m), roleSenders.owner(m.lineId), { businessIds: [m.businessId] }).catch((err) => ({ status: `failed: ${err instanceof Error ? err.message.slice(0, 80) : "error"}` }))).status });
    else {
      const { lineId: _l, command: _c, ...customerOnly } = m;
      void _l;
      void _c;
      customerMessages.push(customerOnly as ParsedInbound);
    }
  }
  const sender = roleSenders.customer();
  const results = [];
  for (const [i, message] of customerMessages.entries()) {
    // An error mid-way leaves the message's inbox record at its last persisted stage: a retry resumes it there.
    // (Without the concurrency guard — migration 0019 — this fails closed: nothing runs, nothing is sent, Meta retries later.)
    results.push(await processInbound(message, sender, { arrivedAt: arrivedAt + i * 0.0001 }).catch((err) => ({ status: "failed" as const, conversationId: message.conversationId, error: err instanceof Error ? err.message.slice(0, 160) : "error", retry: true })));
  }
  // Owner line: the owner command channel (never a customer conversation).
  const ownerResults = [];
  for (const m of parsed.owner) ownerResults.push(await processOwnerInbound(m, whatsappOwnerSender()).catch((err) => ({ status: "failed" as const, error: err instanceof Error ? err.message.slice(0, 120) : "error" })));
  // Founder line: the Founder BARRY command channel (verified founder identities only; never a customer or owner path).
  const founderResults = [];
  for (const m of parsed.founder) founderResults.push(await processFounderInbound(m, whatsappFounderSender()).catch((err) => ({ status: "failed" as const, error: err instanceof Error ? err.message.slice(0, 120) : "error" })));
  // A customer sent something BARRY can't open: tell the owner once (the customer was already answered honestly).
  for (const [i, m] of customerMessages.entries()) {
    const r = results[i];
    if (!m.media || (r.status !== "processed" && r.status !== "held")) continue;
    const who = m.profileName?.trim() || `the customer on •••${m.identity.channelUserId.slice(-4)}`;
    await notifyOwnerAlert(resolveBusinessGraph(m.businessId), `media:${m.inboundId}`, mediaAlertText(who, m.media.type, m.media.caption), { conversationId: m.conversationId }).catch((err) => console.warn("[barry:owner-brief] media alert failed", err instanceof Error ? err.message : err));
  }
  // A customer turn may have created a request for the owner: announce it once on the owner line.
  for (const businessId of new Set(customerMessages.map((m) => m.businessId))) {
    const graph = resolveBusinessGraph(businessId);
    await notifyOwnerDecisions(graph).catch((err) => console.warn("[barry:owner-brief] decision notice failed", err instanceof Error ? err.message : err));
    await notifyOwnerAttention(graph).catch((err) => console.warn("[barry:owner-brief] attention notice failed", err instanceof Error ? err.message : err));
  }
  if (parsed.unrouted.length) console.warn("[barry:whatsapp] message for an unrouted number", { count: parsed.unrouted.length });
  if (parsed.unsupported.length) console.warn("[barry:whatsapp] unsupported message types", parsed.unsupported.map((u) => u.type));
  for (const s of parsed.statuses) if (s.status === "failed") console.warn("[barry:whatsapp] delivery failed", { error: s.error });
  const summary = { roles: roleResults, received: parsed.messages.length, processed: results.filter((r) => r.status === "processed").length, duplicates: results.filter((r) => r.status === "duplicate").length, queued: results.filter((r) => r.status === "queued").length, owner: [...ownerResults.map((r) => r.status), ...roleResults.filter((r) => r.role === "owner").map((r) => r.status)], founder: [...founderResults.map((r) => r.status), ...roleResults.filter((r) => r.role === "founder").map((r) => r.status)] };
  // A message that couldn't be processed yet (its conversation was busy, or a retryable failure with
  // nothing sent) asks Meta to deliver again: the inbox deduplicates every retry, so nothing runs twice
  // and nothing is sent twice. Everything else is acknowledged (failures are recorded per conversation).
  if (results.some((r) => (r.status === "queued" || r.status === "failed") && "retry" in r && r.retry)) return Response.json({ ...summary, retry: true }, { status: 500 });
  return Response.json(summary);
}
