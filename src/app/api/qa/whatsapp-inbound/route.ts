import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerAuthError } from "@/lib/owner-auth";
import { qaEnabled } from "@/lib/qa/mode";
import { graphOrNull } from "@/lib/learn-business/http";
import { parseWebhook } from "@/lib/channels/whatsapp";
import { processInbound, type OutboundSender } from "@/lib/channels/gateway";

/**
 * QA ONLY: simulate an inbound WhatsApp Cloud API event through the REAL adapter (payload parsing,
 * routing, identity) and the REAL gateway (at-most-once processing, runtime, reply, delivery record).
 * Replies are always dry-run here — nothing is ever sent to Meta. Replaying the same messageId shows
 * dedupe. Never available on Vercel Production; gated by owner access to the business.
 */
const QA_PHONE_NUMBER_ID = "qa-simulated-number";

const Body = z.object({
  businessId: z.string().min(1),
  from: z.string().regex(/^\d{6,15}$/, "a phone number in international digits, e.g. 972500000001"),
  text: z.string().min(1).max(4000),
  profileName: z.string().max(80).optional(),
  messageId: z.string().max(200).optional(),
});

const dryRun: OutboundSender = {
  channel: "whatsapp",
  mode: "dry_run",
  send: async () => {
    throw new Error("QA harness never sends");
  },
};

export async function POST(req: NextRequest) {
  if (!qaEnabled()) return new Response("Not found", { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const denied = ownerAuthError(req, parsed.success ? parsed.data.businessId : undefined);
  if (denied) return denied;
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  if (!graphOrNull(parsed.data.businessId)) return Response.json({ error: "Unknown business" }, { status: 404 });
  const messageId = parsed.data.messageId ?? `wamid.QA${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.toUpperCase();
  const payload = {
    object: "whatsapp_business_account",
    entry: [{ id: "qa-waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "QA", phone_number_id: QA_PHONE_NUMBER_ID }, contacts: [{ wa_id: parsed.data.from, profile: { name: parsed.data.profileName ?? "QA customer" } }], messages: [{ id: messageId, from: parsed.data.from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: parsed.data.text } }] } }] }],
  };
  const normalized = parseWebhook(payload, { [QA_PHONE_NUMBER_ID]: parsed.data.businessId });
  const message = normalized.messages[0];
  if (!message) return Response.json({ error: "The simulated event did not normalize", normalized }, { status: 422 });
  const result = await processInbound(message, dryRun);
  return Response.json({ messageId, normalized: { conversationId: message.conversationId, customerId: message.customerId, businessId: message.businessId, text: message.text }, result });
}
