import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { getBackend } from "@/lib/store";
import { resetControlsCacheForTests, applyControlChange, DEFAULT_CONTROLS } from "@/lib/hq/controls";
import { whatsappOwnerReach } from "@/lib/channels/whatsapp";
import { setRoleSendersOverride } from "@/lib/channels/role-routing";
import { createLinkCode, listOwnerIdentities } from "@/lib/owner-channel/identity";
import { processOwnerInbound } from "@/lib/owner-channel/gateway";
import type { OwnerInbound, OwnerSender } from "@/lib/owner-channel/transport";
import { interpretCommand } from "@/lib/owner/command";
import { ownerSenderFor, notifyOwnerAlert, attentionItems } from "@/lib/owner/briefs";
import { businessProblems, problemText, providerError, type BusinessProblem } from "@/lib/owner/problems";
import { deriveIncidents } from "@/lib/hq/incidents";
import { launchChecklist, ownerDesignPartnerView } from "@/lib/hq/launch";
import { listPaymentHealthEvents } from "@/lib/payments/health";
import { processPaymentWebhook, setPaymentAdapterForTests } from "@/lib/payments/capability";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import type { ConnectionView } from "@/lib/connections/status";
import type { JobRecord } from "@/lib/background/runner";
import type { ConversationState } from "@/lib/state";
import type { PaymentAdapter } from "@/lib/payments/adapters/types";
import { CHANNEL_DELIVERY_KEY } from "@/lib/operator/execution-state";

/**
 * OWNER DESIGN PARTNER HARDENING — the gaps between a proven Owner WhatsApp and a real owner using BARRY every day:
 * the shared number is enough (linking, replies AND proactive notices), retried LINKs are harmless, the daily
 * questions are understood in Hebrew and English, broken things are told in the six owner answers (and reach the
 * founder as incidents), and the Design Partner gate is READY FOR SUPERVISED or BLOCKED — never a percentage.
 */

const BIZ = "fashion-retailer";
const saved = { ...process.env };
beforeEach(() => {
  resetControlsCacheForTests();
  Object.assign(process.env, { WHATSAPP_VERIFY_TOKEN: "v", WHATSAPP_APP_SECRET: "s", WHATSAPP_ACCESS_TOKEN: "t", BARRY_WHATSAPP_ROUTES: `PNID-SHARED=${BIZ}`, BARRY_WHATSAPP_SEND: "dry_run", BARRY_OWNER_TOKEN: "test-owner-token-0123456789", BARRY_WHATSAPP_ROLE_ROUTING: "identity" });
  delete process.env.BARRY_WHATSAPP_OWNER_NUMBERS;
});
afterEach(() => {
  setRoleSendersOverride(undefined);
  setPaymentAdapterForTests(undefined);
  resetControlsCacheForTests();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const inbound = (text: string, from: string, messageId: string): OwnerInbound => ({ channel: "whatsapp", messageId, channelUserId: from, verifiedIdentifier: `phone:${from}`, receivedAt: new Date().toISOString(), text });
const dry: OwnerSender = { channel: "whatsapp", mode: "dry_run", send: async () => ({}) };

describe("the shared number is enough (no separate owner phone_number_id)", () => {
  it("owner reach: shared line with identity routing; none without; a dedicated owner line still wins", () => {
    expect(whatsappOwnerReach(BIZ)).toMatchObject({ configured: true, via: "shared_line", lineId: "PNID-SHARED", sendMode: "dry_run" });
    process.env.BARRY_WHATSAPP_ROLE_ROUTING = "off";
    expect(whatsappOwnerReach(BIZ)).toMatchObject({ configured: false, via: "none" });
    process.env.BARRY_WHATSAPP_OWNER_NUMBERS = "PNID-OWNER";
    expect(whatsappOwnerReach(BIZ)).toMatchObject({ configured: true, via: "owner_line", lineId: "PNID-OWNER" });
  });

  it("proactive notices go out from the line the owner last wrote to (the shared number), as the OWNER role — not “blocked: no owner line”", async () => {
    const lines: (string | undefined)[] = [];
    setRoleSendersOverride({ customer: () => ({ channel: "whatsapp", mode: "dry_run", send: async () => ({}) }), owner: (lineId) => (lines.push(lineId), dry), founder: () => dry });
    const phone = "999800000071";
    const { code } = await createLinkCode(BIZ);
    const linked = await processOwnerInbound(inbound(`LINK ${code}`, phone, "wamid.dp.link.1"), dry, { businessIds: [BIZ], lineId: "PNID-SHARED" });
    expect(linked.status).toBe("linked");
    const link = (await listOwnerIdentities(BIZ)).find((l) => l.channelUserId === phone)!;
    expect(link.lineId).toBe("PNID-SHARED");
    expect(ownerSenderFor(BIZ, link)?.mode).toBe("dry_run");
    await applyControlChange(BIZ, { mode: "supervised" }, { by: "founder (test)", reason: "test" });
    const sent = (await notifyOwnerAlert(resolveBusinessGraph(BIZ), "dp-shared-test", "A test alert")).filter((b) => b.to === `···${phone.slice(-4)}`);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: "dry_run" });
    expect(lines).toContain("PNID-SHARED");
    await applyControlChange(BIZ, { mode: DEFAULT_CONTROLS.mode }, { by: "founder (test)", reason: "test" });
  });

  it("a retried LINK delivery (same provider id) never links or replies twice", async () => {
    let replies = 0;
    const counting: OwnerSender = { channel: "whatsapp", mode: "live", send: async () => (replies++, {}) };
    const phone = "999800000072";
    const { code } = await createLinkCode(BIZ);
    const first = await processOwnerInbound(inbound(`LINK ${code}`, phone, "wamid.dp.link.2"), counting, { businessIds: [BIZ] });
    const again = await processOwnerInbound(inbound(`LINK ${code}`, phone, "wamid.dp.link.2"), counting, { businessIds: [BIZ] });
    expect(first.status).toBe("linked");
    expect(again).toMatchObject({ status: "rejected" });
    expect("delivery" in again && again.delivery).toBeFalsy();
    expect(replies).toBe(1);
    expect((await listOwnerIdentities(BIZ)).filter((l) => l.channelUserId === phone)).toHaveLength(1);
  });
});

describe("the owner's daily questions (Hebrew and English) — one deterministic meaning each", () => {
  it.each([
    ["מה צריך אותי?", "needs_you"],
    ["מה קורה היום?", "working"],
    ["מה ברי עושה עכשיו?", "working"],
    ["מי מחכה לי?", "needs_you"],
    ["מי מחכה ללקוח?", "waiting_customers"],
    ["מה קורה עם הכסף?", "money"],
    ["יש משהו תקוע?", "waiting"],
    ["למה הלקוח הזה מחכה?", "customer"],
    ["תראה לי מה צריך אישור", "needs_you"],
    ["What needs me?", "needs_you"],
    ["What's going on with the money?", "money"],
    ["Is anything stuck?", "waiting"],
    ["Why is this customer waiting?", "customer"],
    ["Who is waiting on the customer?", "waiting_customers"],
    ["Show me what needs approval", "needs_you"],
  ])("%s → %s", (text, topic) => {
    expect(interpretCommand(text, "whatsapp").intent).toMatchObject({ kind: "query", topic });
  });

  it("money words still win: “what money is stuck?” stays a money question", () => {
    expect(interpretCommand("What money is stuck?").intent).toMatchObject({ kind: "query", topic: "money", money: "stuck" });
  });

  it.each([
    ["switch to supervised mode", "supervised"],
    ["go live", "live"],
    ["תעבור למצב פיקוח", "supervised"],
    ["תעביר את ברי למצב פעיל", "live"],
  ])("“%s” is a mode-switch REQUEST (→ %s), never pause / resume", (text, to) => {
    expect(interpretCommand(text).intent).toEqual({ kind: "mode_switch_request", to });
  });

  it("pause / resume and the mode question are unchanged", () => {
    expect(interpretCommand("pause BARRY").intent).toEqual({ kind: "mode_change", to: "paused" });
    expect(interpretCommand("תחזיר אותו לעבוד").intent).toEqual({ kind: "mode_change", to: "resumed" });
    expect(interpretCommand("what mode are we in?").intent).toEqual({ kind: "mode_query" });
  });
});

const now = new Date("2026-10-05T12:00:00Z");
const conn = (o: Partial<ConnectionView>): ConnectionView => ({ capability: "payments", provider: "payplus", status: "connected", origin: "business_connection", simulated: false, lastVerifiedAt: "2026-10-01T00:00:00Z", permissions: [], settings: {}, setup: [], missing: [], operations: [], ...o }) as ConnectionView;
const job = (o: Partial<JobRecord>): JobRecord => ({ businessId: BIZ, job: "followups", slot: "s1", status: "ran", attempts: 1, mode: "supervised", claimedAt: "2026-10-05T10:00:00Z", ...o }) as JobRecord;
const convoWithDelivery = (id: string, status: string, at: string, error?: string): ConversationState => ({ id, businessId: BIZ, knownFields: { [CHANNEL_DELIVERY_KEY]: JSON.stringify([{ at, channel: "whatsapp", inboundId: `in-${id}`, status, ...(error ? { error } : {}) }]) }, messages: [], turns: [] }) as unknown as ConversationState;
const empty = { connections: [] as ConnectionView[], jobs: [] as JobRecord[], ownerDeliveries: [], conversations: [] as ConversationState[], payments: [], now };

describe("business problems — the six owner answers, from records only", () => {
  it("a real system down → a problem (customer blocked; nothing happened; owner action; next step); simulators and never-connected systems are not failures", () => {
    const p = businessProblems({ ...empty, connections: [conn({ status: "error" }), conn({ capability: "scheduling", simulated: true, status: "error" }), conn({ capability: "commerce", status: "not_configured", origin: "none" })] });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: "connection", severity: "high", customerBlocked: true });
    const text = problemText(p[0]);
    for (const part of [/payment provider/, /Affected:/, /Customer blocked: Yes/, /Already happened: .*nothing is charged/, /You need to: Reconnect/, /Next:/]) expect(text).toMatch(part);
    expect(problemText(p[0], "he")).toMatch(/לקוח תקוע: כן/);
  });

  it("a failed scheduled run is a problem only until a later run of the same job succeeds", () => {
    const failed = job({ status: "failed", claimedAt: "2026-10-05T09:00:00Z", error: "db timeout", summary: { sent: 2 } as never });
    expect(businessProblems({ ...empty, jobs: [failed] })[0]).toMatchObject({ kind: "background_job", customerBlocked: false });
    expect(businessProblems({ ...empty, jobs: [failed] })[0].alreadyHappened.en).toMatch(/2 follow-ups were sent before it failed; nothing was sent twice/);
    expect(businessProblems({ ...empty, jobs: [failed, job({ status: "ran", claimedAt: "2026-10-05T11:00:00Z" })] })).toHaveLength(0);
  });

  it("WhatsApp refusing messages to the OWNER (401 / 190) → plain words + the provider code as evidence; dry runs are not failures", () => {
    const p = businessProblems({ ...empty, ownerDeliveries: [{ at: "2026-10-05T11:00:00Z", to: "owner", status: "failed", reason: "WhatsApp send failed (401 / 190)", via: "reply" }, { at: "2026-10-05T11:10:00Z", to: "owner", status: "dry_run", via: "notice" }] });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: "owner_channel", customerBlocked: false, occurrences: 1 });
    expect(p[0].what.en).toMatch(/access token expired or was revoked/);
    expect(p[0].evidence[0]).toMatch(/provider error 401\/190/);
    expect(p[0].alreadyHappened.en).toMatch(/Nothing was marked as sent/);
  });

  it("several customers' replies refused → one business-wide problem; one customer is that conversation's own item", () => {
    const a = convoWithDelivery("wa:x:1", "failed", "2026-10-05T11:00:00Z", "WhatsApp send failed (401 / 190)");
    const b = convoWithDelivery("wa:x:2", "failed", "2026-10-05T11:05:00Z", "WhatsApp send failed (401 / 190)");
    expect(businessProblems({ ...empty, conversations: [a] })).toHaveLength(0);
    expect(businessProblems({ ...empty, conversations: [a, b] })[0]).toMatchObject({ kind: "customer_delivery", severity: "high", customerBlocked: true, occurrences: 2 });
  });

  it("an unverifiable payment event → never counted as paid; whether the customer was charged is UNKNOWN (said so)", () => {
    const p = businessProblems({ ...empty, payments: [{ at: "2026-10-05T11:00:00Z", provider: "payplus", paymentId: "pr_1", reason: "amount mismatch" }] });
    expect(p[0]).toMatchObject({ kind: "payment_verification", customerBlocked: "unknown" });
    expect(problemText(p[0])).toMatch(/Customer blocked: Unknown from BARRY's records/);
  });

  it("provider error codes in plain words", () => {
    expect(providerError("WhatsApp send failed (401 / 190)")).toMatchObject({ code: "401/190" });
    expect(providerError("WhatsApp send failed (400 / 131047)").plain.en).toMatch(/24 hours/);
    expect(providerError(undefined)).toMatchObject({ code: null });
  });

  it("owner notices include system problems — except a failing OWNER channel (it would fail too; web + founder show it)", () => {
    const problems = businessProblems({ ...empty, connections: [conn({ status: "disconnected" })], ownerDeliveries: [{ at: "2026-10-05T11:00:00Z", to: "owner", status: "failed", reason: "WhatsApp send failed (401 / 190)", via: "reply" }] });
    const items = attentionItems({ interventions: [], opportunities: { items: [] }, problems } as never);
    expect(items.map((i) => i.category)).toEqual(["system_problem"]);
    expect(items[0].en).toMatch(/disconnected/);
  });

  it("the founder sees the same problems as incidents (owner channel, customer delivery, background job, payment)", () => {
    const problems: BusinessProblem[] = businessProblems({
      ...empty,
      ownerDeliveries: [{ at: "2026-10-05T11:00:00Z", to: "owner", status: "failed", reason: "WhatsApp send failed (401 / 190)", via: "reply" }],
      jobs: [job({ status: "failed" })],
      payments: [{ at: "2026-10-05T11:00:00Z", provider: "payplus", reason: "amount mismatch" }],
      conversations: [convoWithDelivery("wa:x:1", "failed", "2026-10-05T11:00:00Z", "x (401 / 190)"), convoWithDelivery("wa:x:2", "failed", "2026-10-05T11:01:00Z", "x (401 / 190)")],
    });
    const kinds = deriveIncidents({ graph: resolveBusinessGraph(BIZ), conversations: [], approvals: [], payments: [], connections: [], ai: { status: "healthy" } as never, now, problems }).map((i) => i.kind).sort();
    expect(kinds).toEqual(["background_job_failed", "customer_delivery_failing", "owner_channel_failing", "payment_unverified"]);
  });
});

describe("payment verification failures are recorded for the owner and founder", () => {
  it("a verified provider event whose amount doesn't match BARRY's record is never applied, and is recorded", async () => {
    const backend = getBackend();
    const pr = await backend.createPaymentRequest({ businessId: BIZ, conversationId: "wa:dp:pay", customerId: "wa:dp", amount: 100, currency: "ILS", reason: "test", provider: "memory", providerPaymentId: "pp-dp-1" });
    setPaymentAdapterForTests({ verifyWebhook: async () => ({ provider: "memory", providerEventId: "ev-dp-1", providerPaymentId: "pp-dp-1", status: "paid", verifiedAt: new Date().toISOString(), amount: 1 }) } as unknown as PaymentAdapter);
    await expect(processPaymentWebhook("{}", {})).rejects.toThrow(/amount mismatch/);
    expect((await backend.getPaymentRequest(pr.id))?.status).toBe("pending");
    expect((await listPaymentHealthEvents(BIZ)).some((e) => e.paymentId === pr.id && /amount mismatch/.test(e.reason))).toBe(true);
  });
});

describe("the Design Partner gate: READY FOR SUPERVISED or BLOCKED", () => {
  it("binary, strict (unknown = BLOCKED), shared-line reach counts, a synthetic QA owner link never counts, owner words for every blocker", async () => {
    const graph = resolveBusinessGraph(BIZ);
    const { code } = await createLinkCode(BIZ);
    await processOwnerInbound(inbound(`LINK ${code}`, "999800000073", "wamid.dp.link.3"), dry, { businessIds: [BIZ] });
    const gate = await launchChecklist(graph, { controls: { ...DEFAULT_CONTROLS, mode: "supervised" }, conversations: [] });
    const required = gate.items.filter((i) => i.requiredForSupervised);
    expect(gate.verdict === "READY_FOR_SUPERVISED").toBe(required.every((i) => i.status === "ready"));
    expect(gate.items.find((i) => i.id === "channel.owner_whatsapp_reach")?.status).toBe("ready");
    expect(gate.items.find((i) => i.id === "channel.owner_whatsapp_linked")?.status).toBe("blocked");
    expect(gate.items.find((i) => i.id === "incidents.critical")).toBeDefined();
    const view = ownerDesignPartnerView(gate);
    expect(view.verdict).toBe("BLOCKED");
    expect(view.blockers.length).toBeGreaterThan(0);
    for (const b of view.blockers) {
      expect(b.why.length).toBeGreaterThan(0);
      expect(b.next.length).toBeGreaterThan(0);
      expect(["you", "the BARRY team"]).toContain(b.who);
    }
    expect(view.blockers.find((b) => b.id === "channel.owner_whatsapp_linked")).toMatchObject({ who: "you" });
  });
});

describe("QA can never notify the real founder (QA-owned synthetic artifacts, decided from the records — no timing)", () => {
  const post = async (from: string, text: string, id: string) => {
    const { NextRequest } = await import("next/server");
    const crypto = await import("node:crypto");
    const { POST } = await import("@/app/api/channels/whatsapp/route");
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PNID-SHARED" }, contacts: [{ wa_id: from, profile: { name: "Dana" } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });
    const sig = `sha256=${crypto.createHmac("sha256", "s").update(raw, "utf8").digest("hex")}`;
    return POST(new NextRequest("https://x/api/channels/whatsapp", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body: raw }));
  };
  it("the SAME refused reply raises a founder alert for a real customer, and never for a synthetic QA customer", async () => {
    const { setReasonerForTests } = await import("@/lib/reasoner");
    const { ScriptedModel } = await import("./support/scripted-model");
    const { MemoryLockStore, setLockStoreForTests } = await import("@/lib/state/lock");
    const { MemoryInboxStore, setInboxStoreForTests } = await import("@/lib/channels/inbox");
    const { founderAlertItems } = await import("@/lib/founder-channel/alerts");
    const { getBusinessStatus } = await import("@/lib/hq/fleet");
    setLockStoreForTests(new MemoryLockStore());
    setInboxStoreForTests(new MemoryInboxStore());
    setReasonerForTests(new ScriptedModel(() => undefined));
    const refused: OutboundSenderLike = { channel: "whatsapp", mode: "live", send: async () => Promise.reject(new Error("WhatsApp send failed (401 / 190)")) };
    setRoleSendersOverride({ customer: () => refused as never, owner: () => dry, founder: () => dry });
    try {
      const realPhone = "972500000123";
      const qaPhone = "999550000123";
      await post(realPhone, "Hi, are you open on Friday?", "wamid.dp.real.1");
      await post(qaPhone, "Hi, are you open on Friday?", "wamid.dp.qa.1");
      const status = await getBusinessStatus(resolveBusinessGraph(BIZ), { detail: true });
      expect(status.incidents.open.some((i) => i.key === `undelivered_reply:wa:${BIZ}:${realPhone}`)).toBe(true);
      expect(status.incidents.open.some((i) => i.key.includes(qaPhone))).toBe(false);
      const items = await founderAlertItems({ launch: false });
      // Positive control: the real customer's failure IS a founder alert item …
      expect(items.some((i) => i.key.includes(`wa:${BIZ}:${realPhone}`))).toBe(true);
      // … the identical synthetic one never is.
      expect(items.some((i) => i.key.includes(qaPhone) || i.text.includes(qaPhone))).toBe(false);
    } finally {
      setReasonerForTests(undefined);
      setLockStoreForTests(undefined);
      setInboxStoreForTests(undefined);
    }
  }, 60_000);

  it("QA-owned problems and incidents are explicitly marked; real ones never are; QA problems are never announced to an owner", () => {
    const qa = convoWithDelivery(`wa:${BIZ}:999550000001`, "failed", "2026-10-05T11:00:00Z", "x (401 / 190)");
    const qa2 = convoWithDelivery(`wa:${BIZ}:999550000002`, "failed", "2026-10-05T11:01:00Z", "x (401 / 190)");
    const problems = businessProblems({ ...empty, conversations: [qa, qa2], ownerDeliveries: [{ at: "2026-10-05T11:00:00Z", to: "owner", status: "failed", reason: "WhatsApp send failed (401 / 190)", via: "reply", synthetic: true }] });
    expect(problems.map((p) => `${p.kind}:${p.qa}`).sort()).toEqual(["customer_delivery:true", "owner_channel:true"]);
    expect(attentionItems({ interventions: [], opportunities: { items: [] }, problems } as never)).toEqual([]);
    const incidents = deriveIncidents({ graph: resolveBusinessGraph(BIZ), conversations: [qa, qa2], approvals: [], payments: [], connections: [], ai: { status: "healthy" } as never, now, problems });
    expect(incidents.length).toBeGreaterThan(0);
    expect(incidents.every((i) => i.qa === true)).toBe(true);
    const real = businessProblems({ ...empty, ownerDeliveries: [{ at: "2026-10-05T11:00:00Z", to: "owner", status: "failed", reason: "WhatsApp send failed (401 / 190)", via: "reply", synthetic: false }] });
    expect(real[0].qa).toBeUndefined();
  });
});
type OutboundSenderLike = { channel: "whatsapp"; mode: "live"; send: () => Promise<never> };
