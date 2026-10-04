import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { setReasonerForTests } from "@/lib/reasoner";
import { getConversationStore } from "@/lib/state";
import { processInbound, readDeliveries, renderForTextChannel, type OutboundSender } from "@/lib/channels/gateway";
import { stripMarkdown, renderRichText, renderRichCards } from "@/lib/channels/rich";
import { linkIdentities, resolveCustomerIdentity, conversationsOfLink, listIdentityLinks } from "@/lib/channels/identity";
import { channelHealth, customerChannelState } from "@/lib/channels/health";
import { getChannelAdapter, listChannelAdapters } from "@/lib/channels/adapters";
import { canLinkIdentities, identityVerification } from "@/lib/channels/types";
import { parseWebhook } from "@/lib/channels/whatsapp";
import { applyControlChange, resetControlsCacheForTests } from "@/lib/hq/controls";
import { ScriptedModel, isolatedRetailer } from "./support/scripted-model";

/**
 * CHECKPOINT 4 — CHANNELS / CUSTOMER CONTINUITY: one runtime contract across adapters, a provider-
 * independent rich reply model (no Markdown leaks), verified-only cross-channel identity, observable
 * channel health (no secrets), and emergency pause of a business at the gateway.
 */

let dispose: (() => void) | undefined;
beforeEach(() => resetControlsCacheForTests());
afterEach(() => {
  setReasonerForTests(undefined);
  resetControlsCacheForTests();
  dispose?.();
  dispose = undefined;
});
const NOW = new Date("2026-09-30T12:00:00.000Z");

describe("rich replies render for every channel without Markdown", () => {
  it("strips emphasis, headings, code and link syntax; cards, CTAs, order and payment status render as plain lines", () => {
    expect(stripMarkdown("# Title\n**Bold** and _soft_ and `code` and [link](https://x.example/p)\n- item")).toBe("Title\nBold and soft and code and link https://x.example/p\n• item");
    const text = renderRichText({ conversationId: "web:b:1", text: "Here are two options:", rich: { products: [{ title: "Midnight Wrap Dress", price: "₪420", variant: "M · black", availability: "in stock", url: "https://shop.example/p/1" }], cta: [{ kind: "pay", label: "Pay securely", url: "https://pay.example/x" }], paymentUrl: "https://pay.example/x", order: { label: "Order ORD-1", reference: "ORD-1", status: "shipped", eta: "Thu" }, payment: { label: "Payment", status: "pending", amount: "₪420" } } });
    expect(text).toContain("• Midnight Wrap Dress (M · black) — ₪420 · in stock");
    expect(text).toContain("Pay securely: https://pay.example/x");
    expect(text.split("https://pay.example/x").length).toBe(2); // the CTA already carries the payment link: not repeated
    expect(text).toContain("Order ORD-1: shipped · Thu");
    expect(text).toContain("Payment: pending");
    expect(text).not.toMatch(/\*\*|\[.*\]\(/);
    const cards = renderRichCards({ conversationId: "c", text: "**Hi**", rich: { products: [{ title: "A" }] } });
    expect(cards.text).toBe("Hi");
    expect(cards.cards).toHaveLength(1);
    expect(renderForTextChannel({ conversationId: "c", text: "Your cart is ready: ₪420.", rich: { paymentUrl: "https://pay.example/y" } })).toBe("Your cart is ready: ₪420.\nhttps://pay.example/y");
  });
  it("adapters share one contract: web and WhatsApp are registered, Instagram is declared but not configured", () => {
    expect(listChannelAdapters()).toEqual([{ channel: "web", configured: true }, { channel: "whatsapp", configured: true }, { channel: "instagram", configured: false }]);
    expect(getChannelAdapter("whatsapp")?.channel).toBe("whatsapp");
  });
});

describe("verified cross-channel identity", () => {
  it("links only on the same provider-verified identifier; names never link; a linked identity resolves to one customer", async () => {
    const { g } = isolatedRetailer();
    dispose = () => undefined;
    const wa = { channel: "whatsapp" as const, channelUserId: "972500000001", verifiedIdentifier: "phone:972500000001" };
    const web = { channel: "web" as const, channelUserId: "sess-1" };
    const webVerified = { channel: "web" as const, channelUserId: "sess-2", verifiedIdentifier: "phone:972500000001" };
    expect(identityVerification(web)).toBe("unverified");
    expect(canLinkIdentities(wa, web)).toBe(false);
    expect((await linkIdentities(g.business.id, wa, web)).ok).toBe(false);
    expect((await linkIdentities(g.business.id, wa, { ...webVerified, verifiedIdentifier: "phone:972500000002" })).ok).toBe(false);
    const linked = await linkIdentities(g.business.id, wa, webVerified, NOW);
    expect(linked.ok).toBe(true);
    const r = await resolveCustomerIdentity(g.business.id, webVerified);
    expect(r).toEqual({ customerId: "whatsapp:972500000001", linked: true, verified: true });
    expect(await resolveCustomerIdentity(g.business.id, web)).toEqual({ customerId: "web:sess-1", linked: false, verified: false });
    // Idempotent, and a third identity with the same verified identifier joins the same link.
    await linkIdentities(g.business.id, wa, webVerified, NOW);
    const again = await linkIdentities(g.business.id, wa, { channel: "instagram", channelUserId: "ig-9", verifiedIdentifier: "phone:972500000001" }, NOW);
    expect(again.ok && again.link.identities).toHaveLength(3);
    expect(await listIdentityLinks(g.business.id)).toHaveLength(1);
    const link = (await listIdentityLinks(g.business.id))[0];
    expect(conversationsOfLink(link, [`wa:${g.business.id}:972500000001`, `web:${g.business.id}:sess-2`, `web:${g.business.id}:other`])).toEqual([`wa:${g.business.id}:972500000001`, `web:${g.business.id}:sess-2`]);
  });

  it("WhatsApp identities carry the provider-verified phone; the gateway uses the canonical customer for a linked identity", async () => {
    const business = "fashion-retailer";
    const sess = `s9-${Date.now()}`;
    setReasonerForTests(new ScriptedModel(() => undefined));
    const parsed = parseWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, messages: [{ id: "m1", from: "972500000001", type: "text", text: { body: "hi" }, timestamp: "1700000000" }] } }] }] }, { PN1: business });
    expect(parsed.messages[0].identity.verifiedIdentifier).toBe("phone:972500000001");
    await linkIdentities(business, parsed.messages[0].identity, { channel: "web", channelUserId: sess, verifiedIdentifier: "phone:972500000001" }, NOW);
    const sender: OutboundSender = { channel: "web", mode: "dry_run", send: async () => ({}) };
    const out = await processInbound({ businessId: business, conversationId: `web:${business}:${sess}`, identity: { channel: "web", channelUserId: sess, verifiedIdentifier: "phone:972500000001" }, text: "hello", receivedAt: NOW.toISOString(), inboundId: `in-${sess}` }, sender);
    expect(out.status).toBe("processed");
    const state = await getConversationStore().get(`web:${business}:${sess}`);
    expect(state?.customerId).toBe("whatsapp:972500000001");
  });
});

describe("channel health is observable and secret-free; a paused business answers nowhere", () => {
  it("states follow configuration and deliveries; missing setup lists names only", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const id = `wa:${r.g.business.id}:972500000009`;
    await getConversationStore().getOrCreate(id, r.g.business.id, "wa:972500000009");
    const state = (await getConversationStore().get(id))!;
    state.knownFields.__channelDelivery = JSON.stringify([{ at: NOW.toISOString(), channel: "whatsapp", inboundId: "x", status: "failed", error: "WhatsApp send failed (401)" }]);
    await getConversationStore().save(state);
    const health = channelHealth({ businessId: r.g.business.id, conversations: [state], now: NOW });
    const wa = health.find((h) => h.channel === "whatsapp")!;
    expect(["missing_setup", "not_configured", "degraded"]).toContain(wa.state);
    expect(JSON.stringify(health)).not.toMatch(/EAAB|secret=|token:/i);
    for (const m of wa.missingSetup) expect(m).toMatch(/^[A-Z_]+$/);
    expect(health.find((h) => h.channel === "instagram")?.state).toBe("not_configured");
    expect(channelHealth({ businessId: r.g.business.id, conversations: [state], disabledChannels: ["whatsapp"], now: NOW }).find((h) => h.channel === "whatsapp")?.state).toBe("disabled");
    expect(["missing_setup", "not_configured", "degraded"]).toContain(customerChannelState(health));
    expect(readDeliveries(state.knownFields)).toHaveLength(1);
  });

  it("pause business: nothing is answered, run or sent — the customer's message is kept for the owner", async () => {
    const business = "barry-logistics-demo";
    setReasonerForTests(new ScriptedModel(() => undefined));
    await applyControlChange(business, { pausedBusiness: true }, { by: "founder", reason: "emergency", now: NOW });
    try {
      const sender: OutboundSender = { channel: "web", mode: "dry_run", send: async () => ({}) };
      const id = `web:${business}:p-${Date.now()}`;
      const out = await processInbound({ businessId: business, conversationId: id, identity: { channel: "web", channelUserId: "p1" }, text: "hello", receivedAt: NOW.toISOString(), inboundId: `in-${id}` }, sender);
      expect(out.status).toBe("held");
      const kept = await getConversationStore().get(id);
      expect(kept?.messages.map((m) => `${m.role}:${m.content}`)).toEqual(["customer:hello"]);
      expect(kept?.turns).toHaveLength(0);
    } finally {
      await applyControlChange(business, { pausedBusiness: false }, { by: "founder", reason: "resume", now: NOW });
    }
  });
});
