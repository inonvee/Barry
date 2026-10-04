import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/lib/fabric";
import { buildLogisticsDemoGraph, demoHelpdeskTickets, resetDemoHelpdeskForTests } from "@/lib/fixtures/logistics-demo";
import { getBusinessGraph } from "@/lib/fixtures";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { getConversationStore } from "@/lib/state";
import { setReasonerForTests } from "@/lib/reasoner";
import { outcomeEvents, revenueSummary } from "@/lib/owner/revenue";
import { getOwnerWorkspace, startOfLocalDay } from "@/lib/owner/service";
import { assessPilotReadiness } from "@/lib/owner/readiness";
import { askOwnerBarry, buildBriefing, checkOwnerAnswer } from "@/lib/owner/ask";
import { parseWebhook, verifySignature, verifyWebhookSubscription, whatsappConfig } from "@/lib/channels/whatsapp";
import { processInbound, type OutboundSender } from "@/lib/channels/gateway";
import { ownerAuthError } from "@/lib/owner-auth";
import { setBusinessGraphResolverForTests } from "@/lib/business-graph-repository";
import type { BusinessGraph } from "@/lib/business-graph";
import type { PaymentRequestRecord } from "@/lib/store/types";
import { ScriptedModel, approvalsOf, conv, ticket } from "./support/scripted-model";

const ENV_KEYS = ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "BARRY_WHATSAPP_ROUTES", "BARRY_WHATSAPP_SEND", "BARRY_OWNER_TOKEN", "BARRY_OWNER_TOKENS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  setReasonerForTests(undefined);
  setBusinessGraphResolverForTests(undefined);
  resetDemoHelpdeskForTests();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── Revenue attribution: evidence only ──────────────────────────────────

describe("revenue attribution never counts unverified money", () => {
  const graph = getBusinessGraph("spa");
  const pay = (over: Partial<PaymentRequestRecord>): PaymentRequestRecord => ({ id: crypto.randomUUID(), businessId: "spa", conversationId: "c1", customerId: "x", amount: 100, currency: "USD", reason: "r", status: "pending", createdAt: new Date().toISOString(), provider: "payplus", ...over });
  const base = { graph, conversations: [], bookings: [], orders: [], approvals: [] };

  it("only provider-reported PAID + verified payments are direct revenue; links, claims and unverified 'paid' are not", () => {
    const now = new Date();
    const r = revenueSummary({
      ...base,
      now,
      payments: [
        pay({ status: "paid", verifiedAt: now.toISOString(), amount: 120 }),
        pay({ status: "paid", amount: 999 }), // "paid" without verification: NOT revenue
        pay({ status: "pending", amount: 50 }), // link sent: potential only
        pay({ status: "failed", amount: 70 }),
      ],
    });
    expect(r.direct).toEqual({ USD: 120 });
    expect(r.directPayments).toBe(1);
    expect(r.potential).toEqual({ USD: 50 });
  });

  it("simulated-provider money is reported apart and never mixed into direct revenue", () => {
    const now = new Date().toISOString();
    const r = revenueSummary({ ...base, payments: [pay({ status: "paid", verifiedAt: now, provider: "memory", amount: 80 })] });
    expect(r.direct).toEqual({});
    expect(r.simulatedPaid).toEqual({ USD: 80 });
  });

  it("recovered is a SUBSET of direct: paid after an earlier failed attempt in the same conversation", () => {
    const t0 = new Date(Date.now() - 3600_000).toISOString();
    const t1 = new Date().toISOString();
    const r = revenueSummary({ ...base, payments: [pay({ status: "failed", createdAt: t0 }), pay({ status: "paid", createdAt: t1, verifiedAt: t1, amount: 100 })] });
    expect(r.direct).toEqual({ USD: 100 });
    expect(r.recovered).toEqual({ USD: 100 });
  });

  it("currencies are never summed together", () => {
    const now = new Date().toISOString();
    const r = revenueSummary({ ...base, payments: [pay({ status: "paid", verifiedAt: now, amount: 100 }), pay({ status: "paid", verifiedAt: now, amount: 390, currency: "ILS" })] });
    expect(r.direct).toEqual({ USD: 100, ILS: 390 });
  });

  it("outcome events carry their evidence; an unpaid link older than 24h is an abandoned checkout", () => {
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    const events = outcomeEvents({ ...base, payments: [pay({ status: "pending", createdAt: old })] });
    expect(events[0]).toMatchObject({ kind: "checkout_abandoned", evidence: "payment still pending" });
  });
});

// ── Owner dashboard reflects authoritative state ───────────────────────

describe("owner workspace reflects authoritative state", () => {
  const C301 = "Parcel Q4-C301 is delayed, open a delay case";

  it("an active approval is actionable and puts the conversation in 'needs you'; once executed it becomes an outcome with its reference", async () => {
    const g = buildLogisticsDemoGraph();
    setReasonerForTests(new ScriptedModel((ctx) => (ctx.customerMessage === C301 ? ticket("Q4-C301") : { advancesTransaction: false })));
    const id = conv("ws");
    await handleCustomerMessage(g, id, "c", C301);
    let ws = await getOwnerWorkspace(g);
    const row = ws.conversations.find((c) => c.id === id)!;
    expect(row).toMatchObject({ status: "needs_you", attention: ["approval_waiting"] });
    const approval = ws.approvals.find((a) => a.conversationId === id)!;
    expect(approval).toMatchObject({ actionable: true, lifecycle: "active" });
    expect(approval.what).toMatch(/Q4-C301/);

    await resumeAfterApproval(g, approval.id, "approved", "owner");
    ws = await getOwnerWorkspace(g);
    expect(ws.approvals.find((a) => a.id === approval.id)).toMatchObject({ actionable: false, lifecycle: "executed" });
    expect(ws.outcomes.find((o) => o.conversationId === id && o.kind === "case_created")).toMatchObject({ reference: "T-1001" });
    expect(ws.conversations.find((c) => c.id === id)?.status).toBe("completed");
  });

  it("a held request is never shown as actionable, and says why", async () => {
    const g = buildLogisticsDemoGraph();
    setReasonerForTests(new ScriptedModel((ctx) => (ctx.customerMessage === C301 ? ticket("Q4-C301") : "FAIL")));
    const id = conv("ws-held");
    await handleCustomerMessage(g, id, "c", C301);
    await handleCustomerMessage(g, id, "c", "wait, C302 not 301");
    const ws = await getOwnerWorkspace(g);
    const a = ws.approvals.find((x) => x.conversationId === id)!;
    expect(a).toMatchObject({ actionable: false, lifecycle: "held" });
    expect(a.newerContext).toMatch(/couldn't understand/);
    expect(ws.conversations.find((c) => c.id === id)?.attention).toEqual(expect.arrayContaining(["approval_held", "ai_unavailable"]));
  });

  it("AI health reports provider quota exhaustion to the owner in plain words (and the failure detail)", async () => {
    const g = buildLogisticsDemoGraph();
    const model = new ScriptedModel(() => "FAIL");
    model.failure = { kind: "provider_quota_exhausted", status: 429, code: "insufficient_quota", message: "quota", transient: false };
    setReasonerForTests(model);
    // Two failed turns hand a conversation to a person (BARRY then stays silent in it), so the failures
    // here come from several customers.
    for (const m of ["hi", "hello?", "anyone?"]) await handleCustomerMessage(g, conv("ws-ai"), "c", m);
    const ws = await getOwnerWorkspace(g);
    expect(ws.health.ai).toMatchObject({ status: "unavailable", lastFailure: { kind: "provider_quota_exhausted", status: 429, code: "insufficient_quota" } });
    expect(ws.health.ai.summary).toMatch(/out of credit/);
  });

  it("'today' starts at midnight in the business's own timezone", () => {
    const start = startOfLocalDay("Asia/Jerusalem", new Date("2026-03-10T10:00:00Z"));
    expect(start).toBe("2026-03-09T22:00:00.000Z");
  });
});

// ── Handoff ─────────────────────────────────────────────────────────────

describe("handoff is real state; the reply only promises what exists", () => {
  const asks = { handoff: { reason: "customer wants to speak with a person about a damaged parcel", urgency: "urgent" as const }, advancesTransaction: false };

  it("no declared response path: the handoff is recorded, and 'the team will contact you' never reaches the customer", async () => {
    const g = buildLogisticsDemoGraph();
    const model = new ScriptedModel(() => asks);
    model.write = () => "I've passed this to the team and someone will contact you shortly.";
    setReasonerForTests(model);
    const id = conv("ho");
    const out = await handleCustomerMessage(g, id, "c", "I want to talk to a human NOW, my parcel is destroyed");
    expect(out.response).not.toMatch(/will contact you/);
    expect(out.response).toMatch(/can't promise when or how they'll reply/);
    const ws = await getOwnerWorkspace(g);
    const h = ws.handoffs.find((x) => x.conversationId === id)!;
    expect(h).toMatchObject({ status: "open", urgency: "urgent", responseCommitted: false, trigger: "customer_asked" });
    expect(h.summary).toMatch(/talk to a human/);
  });

  it("with a declared response path the promise is allowed; a second request never opens a second handoff", async () => {
    const base = buildLogisticsDemoGraph();
    const g: BusinessGraph = { ...base, playbook: { ...base.playbook, handoff: "Dana from the team replies on WhatsApp within 2 business hours" } };
    const model = new ScriptedModel(() => asks);
    model.write = () => "I've passed this to the team — Dana will get back to you within 2 business hours.";
    setReasonerForTests(model);
    const id = conv("ho2");
    const first = await handleCustomerMessage(g, id, "c", "human please");
    expect(first.response).toMatch(/Dana will get back to you/);
    await handleCustomerMessage(g, id, "c", "hello?? a human please");
    const state = (await getConversationStore().get(id))!;
    expect(JSON.parse(state.knownFields.__handoffs)).toHaveLength(1);
  });

  it("two messages in a row BARRY can't understand hand the conversation to the team", async () => {
    const g = buildLogisticsDemoGraph();
    setReasonerForTests(new ScriptedModel(() => "FAIL"));
    const id = conv("ho-ai");
    await handleCustomerMessage(g, id, "c", "first");
    const out = await handleCustomerMessage(g, id, "c", "second");
    expect(out.response).toMatch(/passed this to the business's team/);
    const ws = await getOwnerWorkspace(g);
    expect(ws.handoffs.find((h) => h.conversationId === id)).toMatchObject({ trigger: "ai_unavailable", status: "open" });
  });
});

// ── WhatsApp channel ────────────────────────────────────────────────────

describe("WhatsApp channel gateway", () => {
  const configure = (send?: string) => {
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-me-please";
    process.env.WHATSAPP_APP_SECRET = "app-secret-for-tests";
    process.env.WHATSAPP_ACCESS_TOKEN = "token-for-tests";
    process.env.BARRY_WHATSAPP_ROUTES = "1234567890=barry-logistics-demo";
    if (send) process.env.BARRY_WHATSAPP_SEND = send;
    else delete process.env.BARRY_WHATSAPP_SEND;
  };
  const payload = (id: string, text: string, from = "972500000001") => ({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "1234567890" }, contacts: [{ wa_id: from, profile: { name: "Noa" } }], messages: [{ id, from, timestamp: "1760000000", type: "text", text: { body: text } }] } }] }],
  });

  it("reports exactly what is missing when not configured", () => {
    for (const k of ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "BARRY_WHATSAPP_ROUTES"]) delete process.env[k];
    expect(whatsappConfig()).toMatchObject({ configured: false, missing: ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "BARRY_WHATSAPP_ROUTES"], sendMode: "dry_run" });
  });

  it("webhook handshake echoes the challenge only for the right token; signatures are verified over the raw body", () => {
    configure();
    expect(verifyWebhookSubscription(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "verify-me-please", "hub.challenge": "42" }))).toEqual({ ok: true, challenge: "42" });
    expect(verifyWebhookSubscription(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "42" }))).toEqual({ ok: false });
    const raw = JSON.stringify(payload("m1", "hi"));
    const sig = `sha256=${crypto.createHmac("sha256", "app-secret-for-tests").update(raw).digest("hex")}`;
    expect(verifySignature(raw, sig)).toBe(true);
    expect(verifySignature(`${raw} `, sig)).toBe(false);
    expect(verifySignature(raw, null)).toBe(false);
  });

  it("normalizes a routed text message; unrouted numbers and non-text types are reported, not processed", () => {
    configure();
    const parsed = parseWebhook(payload("m1", "Where is my parcel?"));
    expect(parsed.messages[0]).toMatchObject({ inboundId: "m1", businessId: "barry-logistics-demo", conversationId: "wa:barry-logistics-demo:972500000001", customerId: "wa:972500000001", text: "Where is my parcel?", profileName: "Noa" });
    const other = payload("m2", "x");
    other.entry[0].changes[0].value.metadata.phone_number_id = "999";
    expect(parseWebhook(other).unrouted).toEqual(["999"]);
    const image = payload("m3", "");
    (image.entry[0].changes[0].value.messages[0] as { type: string }).type = "image";
    expect(parseWebhook(image).unsupported[0]).toMatchObject({ type: "image" });
  });

  it("the same WhatsApp message is processed at most once; dry run sends nothing and records it", async () => {
    configure();
    setReasonerForTests(new ScriptedModel(() => ({ advancesTransaction: false })));
    const send = vi.fn();
    const sender: OutboundSender = { channel: "whatsapp", mode: "dry_run", send };
    const [msg] = parseWebhook(payload(`m-${Date.now()}`, "hello")).messages;
    const first = await processInbound(msg, sender);
    const again = await processInbound(msg, sender);
    expect(first).toMatchObject({ status: "processed", delivery: { status: "dry_run" } });
    expect(again.status).toBe("duplicate");
    expect(send).not.toHaveBeenCalled();
    const state = (await getConversationStore().get(msg.conversationId))!;
    expect(state.messages.filter((m) => m.role === "customer")).toHaveLength(1);
  });

  it("live mode sends through the sender; a send failure is recorded as failed (never reported as delivered)", async () => {
    configure("live");
    setReasonerForTests(new ScriptedModel(() => ({ advancesTransaction: false })));
    const [msg] = parseWebhook(payload(`m-${Date.now()}-live`, "hello", "972500000009")).messages;
    const ok = await processInbound(msg, { channel: "whatsapp", mode: "live", send: async () => ({ providerMessageId: "wamid.1" }) });
    expect(ok).toMatchObject({ status: "processed", delivery: { status: "sent", providerMessageId: "wamid.1" } });
    const [msg2] = parseWebhook(payload(`m-${Date.now()}-fail`, "again", "972500000009")).messages;
    const bad = await processInbound(msg2, { channel: "whatsapp", mode: "live", send: async () => { throw new Error("WhatsApp send failed (401)"); } });
    expect(bad).toMatchObject({ status: "processed", delivery: { status: "failed", error: "WhatsApp send failed (401)" } });
  });

  it("the webhook route rejects an unsigned POST before parsing anything", async () => {
    configure();
    const { POST } = await import("@/app/api/channels/whatsapp/route");
    const { NextRequest } = await import("next/server");
    const res = await POST(new NextRequest("http://x/api/channels/whatsapp", { method: "POST", body: JSON.stringify(payload("m9", "hi")) }));
    expect(res.status).toBe(401);
  });
});

// ── Readiness ───────────────────────────────────────────────────────────

describe("paid-pilot readiness is derived from real requirements", () => {
  it("in this environment (no live AI, no database, no channel, no handoff path) a known business is READY FOR TESTING with concrete blockers", async () => {
    const r = await assessPilotReadiness(getBusinessGraph("spa"));
    expect(r.level).toBe("READY_FOR_TESTING");
    const ids = r.next!.blockers.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(["ai.model", "platform.persistence", "channel.configured", "handoff.path"]));
    expect(r.next!.blockers.every((b) => b.fix)).toBe(true);
  });

  it("a business with nothing to offer and no goals is NOT READY", async () => {
    const base = getBusinessGraph("spa");
    const r = await assessPilotReadiness({ ...base, offers: [], goals: [] });
    expect(r.level).toBe("NOT_READY");
    expect(r.next!.blockers.map((b) => b.id)).toEqual(["knowledge.offers", "knowledge.goals"]);
  });
});

// ── Owner Barry ─────────────────────────────────────────────────────────

describe("Owner Barry is read-only and answers only from the briefing", () => {
  it("rejects figures that aren't in the briefing and claims of having done something", async () => {
    const g = getBusinessGraph("spa");
    const ws = await getOwnerWorkspace(g);
    const b = buildBriefing(ws, ws.revenue, await assessPilotReadiness(g));
    expect(checkOwnerAnswer("Barry collected $4,210 today.", b, "how much today?")).toMatch(/figures not in the briefing/);
    expect(checkOwnerAnswer("Done — I've updated the discount rule and approved the request.", b, "approve it")).toMatch(/claims an action/);
    expect(checkOwnerAnswer(`Nothing is waiting for you right now.`, b, "who needs me?")).toBeUndefined();
  });

  it("with no model it returns the factual briefing (never an improvised answer); a model answer that fails checks is replaced", async () => {
    const g = getBusinessGraph("spa");
    const plain = await askOwnerBarry(g, "What happened today?");
    expect(plain.source).toBe("briefing");
    expect(plain.answer).toMatch(/Today at Serenity Massage Spa/);
    const fake = { chat: { completions: { create: async () => ({ choices: [{ message: { content: "You made $9,999 this week and I raised your prices." } }] }) } } };
    const checked = await askOwnerBarry(g, "How did you make me money this week?", { client: fake as never });
    expect(checked.source).toBe("briefing");
    expect(checked.reason).toMatch(/couldn't be verified/);
    const good = { chat: { completions: { create: async () => ({ choices: [{ message: { content: "Nothing is waiting for you right now." } }] }) } } };
    expect((await askOwnerBarry(g, "who needs me?", { client: good as never })).source).toBe("model");
  });
});

// ── Owner access ────────────────────────────────────────────────────────

describe("owner access is least-privilege when per-business tokens are configured", () => {
  const req = (token: string) => new Request("http://x", { headers: { "x-barry-owner-token": token } });
  it("a business's token opens only that business; the operator token opens all", () => {
    delete process.env.BARRY_OWNER_TOKEN;
    process.env.BARRY_OWNER_TOKENS = "spa:spa-owner-token-0001,logistics-demo:logi-owner-token-0002";
    expect(ownerAuthError(req("spa-owner-token-0001"), "spa")).toBeUndefined();
    expect(ownerAuthError(req("spa-owner-token-0001"), "logistics-demo")?.status).toBe(401);
    expect(ownerAuthError(req("spa-owner-token-0001"))?.status).toBe(401);
    process.env.BARRY_OWNER_TOKEN = "operator-token-000000000001";
    expect(ownerAuthError(req("operator-token-000000000001"), "logistics-demo")).toBeUndefined();
  });

  it("owner approval via the API is tenant-checked: another business's request is 'not found'", async () => {
    delete process.env.BARRY_OWNER_TOKEN;
    delete process.env.BARRY_OWNER_TOKENS;
    const g = buildLogisticsDemoGraph();
    setReasonerForTests(new ScriptedModel(() => ticket("Q4-A555")));
    const id = conv("tenant");
    await handleCustomerMessage(g, id, "c", "open a case for Q4-A555");
    const [a] = await approvalsOf(g, id);
    const { POST } = await import("@/app/api/owner/approvals/route");
    const { NextRequest } = await import("next/server");
    const res = await POST(new NextRequest("http://x/api/owner/approvals", { method: "POST", body: JSON.stringify({ businessId: "spa", approvalId: a.id, action: "approve" }) }));
    expect(res.status).toBe(404);
    expect(demoHelpdeskTickets()).toHaveLength(0);
    const ok = await POST(new NextRequest("http://x/api/owner/approvals", { method: "POST", body: JSON.stringify({ businessId: "barry-logistics-demo", approvalId: a.id, action: "approve" }) }));
    expect(ok.status).toBe(200);
    expect(demoHelpdeskTickets()).toHaveLength(1);
  });
});
