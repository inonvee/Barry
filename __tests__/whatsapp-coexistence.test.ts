import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import "@/lib/fabric";
import { setReasonerForTests } from "@/lib/reasoner";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { resetControlsCacheForTests, DEFAULT_CONTROLS } from "@/lib/hq/controls";
import { getConversationStore } from "@/lib/state";
import { readControl, readControlLog } from "@/lib/runtime/control";
import { readDeliveries, setGatewayHookForConversation } from "@/lib/channels/gateway";
import { parseWebhook } from "@/lib/channels/whatsapp";
import { setRoleSendersOverride } from "@/lib/channels/role-routing";
import { BusinessNumberError, customerWhatsappState, listBusinessNumbers, registerBusinessNumber, removeBusinessNumber, setNumberStatus, setTeamRepliesInApp } from "@/lib/channels/business-numbers";
import { TEAM_MEMBER, deleteTakeoverSignals, listTakeoverSignals, recordEcho, takeoverBlocksSend, takeoverPending } from "@/lib/channels/human-takeover";
import { truthfulTranscript } from "@/lib/operator/execution-state";
import { ownerReturnToBarry } from "@/lib/owner/human-control";
import { executeOwnerCommand } from "@/lib/owner/command-service";
import { interpretCommand } from "@/lib/owner/command";
import { launchChecklist } from "@/lib/hq/launch";
import { listBusinessSummaries } from "@/lib/fixtures";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { POST } from "@/app/api/channels/whatsapp/route";
import { ScriptedModel } from "./support/scripted-model";

/**
 * WHATSAPP COEXISTENCE + EMPLOYEE TAKEOVER. A business's own customer number (durable connection, per tenant). When
 * someone at the business replies from the WhatsApp Business app, Meta sends a signed `smb_message_echoes` webhook —
 * the ONLY proof used. The employee always wins: BARRY steps out before anything else leaves, the employee's message
 * is a person's (never BARRY's), and nothing is ever guessed. Customer sends here go to a recording stand-in (no
 * network): a reply that LEAVES is visible; a suppressed one is not.
 */

const SECRET = "test-app-secret-coex";
const BIZ = "fashion-retailer";
const OTHER = listBusinessSummaries().find((b) => b.id !== BIZ)!.id;
const THIRD = listBusinessSummaries().find((b) => b.id !== BIZ && b.id !== OTHER)!.id;
const CONTROL = "PN_CONTROL";
const PN_A = "PN_COEX_A";
const PN_B = "PN_COEX_B";
const saved = { ...process.env };
let sends: { to: string; text: string; id: string }[] = [];
let seq = 0;
const CUST = "972541234567";

beforeEach(async () => {
  for (const k of ["BARRY_WHATSAPP_OWNER_NUMBERS", "BARRY_WHATSAPP_FOUNDER_NUMBERS", "BARRY_WHATSAPP_ROLE_ROUTING"]) delete process.env[k];
  Object.assign(process.env, { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_VERIFY_TOKEN: "v", BARRY_WHATSAPP_ROUTES: `${CONTROL}=${BIZ}`, BARRY_WHATSAPP_SEND: "dry_run", BARRY_OWNER_TOKEN: "test-owner-token-0123456789" });
  resetControlsCacheForTests();
  setLockStoreForTests(new MemoryLockStore());
  setInboxStoreForTests(new MemoryInboxStore());
  setReasonerForTests(new ScriptedModel(() => undefined));
  sends = [];
  // A "live" recording customer sender: nothing leaves the process, but every send is counted with its provider id.
  setRoleSendersOverride({
    customer: () => ({ channel: "whatsapp", mode: "live", send: async (to: string, text: string) => { const id = `wamid.barry.${++seq}`; sends.push({ to, text, id }); return { providerMessageId: id }; } }),
    owner: () => ({ channel: "whatsapp", mode: "dry_run", send: async () => ({}) }),
    founder: () => ({ channel: "whatsapp", mode: "dry_run", send: async () => ({}) }),
  });
  vi.stubGlobal("fetch", async (url: string) => {
    throw new Error(`no network in this test: ${url}`);
  });
  await registerBusinessNumber({ businessId: BIZ, phoneNumberId: PN_A, wabaId: "WABA_A", coexistence: "verified", by: "test" });
  await setTeamRepliesInApp(BIZ, PN_A, true, "test");
  await registerBusinessNumber({ businessId: OTHER, phoneNumberId: PN_B, wabaId: "WABA_B", coexistence: "verified", by: "test" });
  await setTeamRepliesInApp(OTHER, PN_B, true, "test");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const [b, p] of [[BIZ, PN_A], [OTHER, PN_B]] as const) await removeBusinessNumber(b, p);
  for (const b of [BIZ, OTHER]) for (const c of await getConversationStore().listByBusiness(b)) {
    await deleteTakeoverSignals(b, c.id);
    await getConversationStore().deleteConversationsByPrefix(b, c.id);
  }
  setRoleSendersOverride(undefined);
  setReasonerForTests(undefined);
  setLockStoreForTests(undefined);
  setInboxStoreForTests(undefined);
  resetControlsCacheForTests();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const signed = (payload: unknown) => {
  const raw = JSON.stringify(payload);
  return new NextRequest("https://x/api/channels/whatsapp", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}` }, body: raw });
};
const ts = (d = new Date()) => String(Math.floor(d.getTime() / 1000));
async function customer(text: string, o: { line?: string; from?: string; id?: string } = {}) {
  const from = o.from ?? CUST;
  const id = o.id ?? `wamid.in.${++seq}`;
  const res = await POST(signed({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: o.line ?? PN_A }, contacts: [{ wa_id: from, profile: { name: "Dana" } }], messages: [{ id, from, timestamp: ts(), type: "text", text: { body: text } }] } }] }] }));
  return { status: res.status, id, body: (await res.json()) as Record<string, unknown> };
}
const echoPayload = (text: string, o: { line?: string; to?: string; id?: string; at?: Date } = {}) => ({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "smb_message_echoes", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "97230000000", phone_number_id: o.line ?? PN_A }, message_echoes: [{ from: "97230000000", to: o.to ?? CUST, id: o.id ?? `wamid.echo.${++seq}`, timestamp: ts(o.at), type: "text", text: { body: text } }] } }] }] });
async function employee(text: string, o: { line?: string; to?: string; id?: string; at?: Date } = {}) {
  const res = await POST(signed(echoPayload(text, o)));
  return { status: res.status, body: (await res.json()) as { echoes?: { status: string; applied: boolean }[] } };
}
const convo = (b = BIZ, phone = CUST) => getConversationStore().get(`wa:${b}:${phone}`);
const holder = async (b = BIZ, phone = CUST) => readControl((await convo(b, phone))!).holder;

describe("what Meta's echo gives us (parsing only documented fields)", () => {
  it("smb_message_echoes on a routed number → an echo for that line's business; unrouted → nothing; incomplete → dropped", () => {
    const routes = { [PN_A]: BIZ };
    const ok = parseWebhook(echoPayload("Hi from the shop", { id: "wamid.e1" }), routes);
    expect(ok.echoes).toEqual([{ lineId: PN_A, businessId: BIZ, messageId: "wamid.e1", customer: CUST, at: expect.any(String), type: "text", text: "Hi from the shop" }]);
    expect(ok.messages).toHaveLength(0);
    expect(parseWebhook(echoPayload("x", { line: "PN_UNKNOWN" }), routes)).toMatchObject({ echoes: [], unrouted: ["PN_UNKNOWN"] });
    const bad = echoPayload("x");
    delete (bad.entry[0].changes[0].value.message_echoes[0] as { id?: string }).id;
    expect(parseWebhook(bad, routes).echoes).toHaveLength(0);
  });
});

describe("business customer numbers: tenant-scoped, durable, no redeploy", () => {
  it("each number routes to its own business only; an unregistered number routes nowhere", async () => {
    await customer("Hello A", { line: PN_A });
    await customer("Hello B", { line: PN_B });
    await customer("Hello ?", { line: "PN_NOT_REGISTERED", from: "972549999999" });
    expect((await convo(BIZ))?.messages[0]?.content).toBe("Hello A");
    expect((await convo(OTHER))?.messages[0]?.content).toBe("Hello B");
    expect(await getConversationStore().get(`wa:${BIZ}:972549999999`)).toBeUndefined();
  });

  it("a number bound to one business can't be connected to another; BARRY's control number can't become a customer number; reconnect keeps the record", async () => {
    await expect(registerBusinessNumber({ businessId: OTHER, phoneNumberId: PN_A, wabaId: "W", by: "t" })).rejects.toMatchObject({ code: "bound_to_other_business" } satisfies Partial<BusinessNumberError>);
    await expect(registerBusinessNumber({ businessId: OTHER, phoneNumberId: CONTROL, wabaId: "W", by: "t" })).rejects.toMatchObject({ code: "conflicting_route" });
    await setNumberStatus(BIZ, PN_A, "disconnected", "test", "Meta disconnected");
    const again = await registerBusinessNumber({ businessId: BIZ, phoneNumberId: PN_A, wabaId: "WABA_A", by: "test" });
    expect(again).toMatchObject({ status: "connected", teamRepliesInApp: true });
    expect(again.history.length).toBeGreaterThanOrEqual(3);
    expect((await listBusinessNumbers(BIZ)).filter((n) => n.phoneNumberId === PN_A)).toHaveLength(1);
  });
});

describe("employee takeover from the WhatsApp Business app", () => {
  it("BARRY owns by default; a verified employee echo → HUMAN; BARRY silent; customer still stored; employee's message is a person's, in order", async () => {
    await customer("Can I book tomorrow?");
    expect(await holder()).toBe("barry");
    expect(sends).toHaveLength(1);
    const r = await employee("Hi Dana, I'll check for you — Sarah");
    expect(r.body.echoes).toEqual([{ status: "recorded", applied: true }]);
    expect(await holder()).toBe("human");
    const c = (await convo())!;
    const staff = c.messages.filter((m) => m.role === "owner");
    expect(staff).toEqual([expect.objectContaining({ role: "owner", author: TEAM_MEMBER, content: "Hi Dana, I'll check for you — Sarah" })]);
    expect(c.messages.every((m) => m.role !== "barry" || m.content !== staff[0].content)).toBe(true);
    expect(readControl(c)).toMatchObject({ holder: "human", by: TEAM_MEMBER });
    expect(readControl(c).reason).toMatch(/replied manually from the business's WhatsApp/);
    await customer("Thanks! 3pm works?");
    expect(sends).toHaveLength(1);
    expect((await convo())!.messages.at(-1)).toMatchObject({ role: "customer", content: "Thanks! 3pm works?" });
  });

  it("the same echo delivered twice changes nothing the second time", async () => {
    await customer("Hello");
    await employee("On it", { id: "wamid.echo.dup" });
    const again = await employee("On it", { id: "wamid.echo.dup" });
    expect(again.body.echoes?.[0].status).toBe("duplicate");
    const c = (await convo())!;
    expect(c.messages.filter((m) => m.role === "owner")).toHaveLength(1);
    expect(readControlLog(c).filter((e) => e.to === "human")).toHaveLength(1);
  });

  it("BARRY's own Cloud API message is never mistaken for an employee (an echo carrying BARRY's provider id is ignored)", async () => {
    await customer("Hello");
    const barryId = readDeliveries((await convo())!.knownFields).at(-1)!.providerMessageId!;
    const r = await employee("(BARRY's own reply)", { id: barryId });
    expect(r.body.echoes?.[0].status).toBe("own_message");
    expect(await holder()).toBe("barry");
    expect((await convo())!.messages.some((m) => m.role === "owner")).toBe(false);
  });

  it("a DELAYED echo (written before the owner gave the conversation back) joins the history but never takes it again", async () => {
    await customer("Hello");
    const written = new Date(Date.now() - 60_000);
    await employee("first reply", { id: "wamid.echo.1" });
    await ownerReturnToBarry(resolveBusinessGraph(BIZ), `wa:${BIZ}:${CUST}`, "the owner (web)");
    expect(await holder()).toBe("barry");
    await employee("an older message, delivered late", { id: "wamid.echo.late", at: written });
    expect(await holder()).toBe("barry");
    const c = (await convo())!;
    expect(c.messages.some((m) => m.content === "an older message, delivered late" && m.role === "owner")).toBe(true);
    // In time order: the late message sits before the first reply it preceded.
    expect(c.messages.findIndex((m) => m.content === "an older message, delivered late")).toBeLessThan(c.messages.findIndex((m) => m.content === "first reply"));
    // A NEW employee reply after the return takes it again (the owner returned control while the employee kept replying).
    await employee("still here", { id: "wamid.echo.2" });
    expect(await holder()).toBe("human");
  });

  it("return to BARRY: explicit (owner), never by the customer; BARRY then answers the NEXT message only (no replay)", async () => {
    await customer("Hello");
    await employee("I'll handle it");
    await customer("תחזיר לברי");
    await customer("give it back to BARRY");
    expect(await holder()).toBe("human");
    expect(sends).toHaveLength(1);
    await ownerReturnToBarry(resolveBusinessGraph(BIZ), `wa:${BIZ}:${CUST}`, "the owner (web)");
    expect(await holder()).toBe("barry");
    expect(sends).toHaveLength(1);
    await customer("Do you ship to Haifa?");
    expect(sends).toHaveLength(2);
  });

  it("cross-tenant: an echo on business B's number affects only B's conversation with that customer", async () => {
    await customer("Hello A", { line: PN_A });
    await customer("Hello B", { line: PN_B });
    await employee("B's team here", { line: PN_B });
    expect(await holder(OTHER)).toBe("human");
    expect(await holder(BIZ)).toBe("barry");
    expect((await convo(BIZ))!.messages.some((m) => m.role === "owner")).toBe(false);
  });

  it("an employee who writes FIRST (no conversation yet) starts it held by a person; BARRY never replies", async () => {
    await employee("Hi, your order is ready", { to: "972541111111" });
    expect(readControl((await convo(BIZ, "972541111111"))!).holder).toBe("human");
    await customer("Great, thanks", { from: "972541111111" });
    expect(sends).toHaveLength(0);
  });
});

describe("the race: employee and BARRY reply together — the employee ALWAYS wins", () => {
  const id = () => `wamid.echo.race.${++seq}`;
  const echoFor = (text: string) => ({ lineId: PN_A, businessId: BIZ, messageId: id(), customer: CUST, at: new Date().toISOString(), type: "text", text });

  it("employee replied BEFORE BARRY reasons → BARRY doesn't reply", async () => {
    await customer("Hello");
    await employee("Got it");
    await customer("Can I book tomorrow?");
    expect(sends).toHaveLength(1);
  });

  for (const point of ["beforeReasoning", "beforeSend"] as const) {
    it(`employee replies ${point === "beforeReasoning" ? "WHILE BARRY is reasoning" : "after BARRY reasoned, before its reply leaves"} → BARRY's reply is SUPPRESSED (not sent, not shown as sent, never retried)`, async () => {
      await customer("Hello");
      expect(sends).toHaveLength(1);
      const remove = setGatewayHookForConversation(`wa:${BIZ}:${CUST}`, point, async () => {
        // The webhook's first step (durable signal, no lock) — exactly what happens while BARRY holds the lock.
        expect((await recordEcho(echoFor("I'll take this one"))).status).toBe("recorded");
      });
      let inbound = "";
      try {
        inbound = (await customer("Can I book tomorrow?")).id;
      } finally {
        remove();
      }
      expect(sends).toHaveLength(1);
      const c = (await convo())!;
      expect(readControl(c).holder).toBe("human");
      const last = readDeliveries(c.knownFields).at(-1)!;
      expect(last).toMatchObject({ status: "suppressed" });
      expect(last.error).toMatch(/team member|person holds/);
      // The prepared reply is never presented as said, and the employee's message is in the transcript.
      const t = truthfulTranscript(c);
      expect(t.filter((m) => m.role === "barry").at(-1)?.notSent).toBe("suppressed");
      expect(c.messages.some((m) => m.role === "owner" && m.content === "I'll take this one")).toBe(true);
      // A redelivery of the customer's message never sends the suppressed reply later.
      await customer("Can I book tomorrow?", { id: inbound });
      expect(sends).toHaveLength(1);
    });
  }

  it("duplicate / out-of-order webhooks: echo twice around a customer message → one takeover, nothing sent", async () => {
    await customer("Hello");
    const e = echoPayload("Sure", { id: "wamid.echo.ooo" });
    await POST(signed(e));
    const msg = await customer("ok?");
    await POST(signed(e));
    await customer("ok?", { id: msg.id });
    expect(sends).toHaveLength(1);
    expect(readControlLog((await convo())!).filter((x) => x.to === "human")).toHaveLength(1);
    expect((await listTakeoverSignals(BIZ, `wa:${BIZ}:${CUST}`)).length).toBe(1);
  });
});

describe("every BARRY send path sees a takeover the moment it is recorded (before it is applied)", () => {
  it("a recorded-but-not-yet-applied echo blocks follow-ups / proactive sends (the executor's check) and replies", async () => {
    await customer("Hello");
    const c = (await convo())!;
    expect(await takeoverPending(c)).toBe(false);
    expect((await takeoverBlocksSend(c.id)).blocked).toBe(false);
    await recordEcho({ lineId: PN_A, businessId: BIZ, messageId: "wamid.echo.pending", customer: CUST, at: new Date().toISOString(), type: "text", text: "on it" });
    expect(readControl((await convo())!).holder).toBe("barry");
    expect(await takeoverPending((await convo())!)).toBe(true);
    expect(await takeoverBlocksSend(c.id)).toMatchObject({ blocked: true, reason: expect.stringMatching(/team member/) });
  });
});

describe("fail safe: when BARRY can't know who owns the conversation, it doesn't send", () => {
  it("team replies from the app but coexistence isn't verified → BARRY never sends on its own", async () => {
    await registerBusinessNumber({ businessId: BIZ, phoneNumberId: PN_A, wabaId: "WABA_A", coexistence: "pending_verification", by: "test" });
    await customer("Hello");
    expect(sends).toHaveLength(0);
    expect(readDeliveries((await convo())!.knownFields).at(-1)).toMatchObject({ status: "suppressed", error: expect.stringMatching(/can't see those replies/) });
  });
  it("the owner hasn't answered whether the team replies from the app → no autonomous send", async () => {
    await registerBusinessNumber({ businessId: THIRD, phoneNumberId: "PN_COEX_C", wabaId: "W", coexistence: "verified", by: "test" });
    try {
      await customer("Hello", { line: "PN_COEX_C" });
      expect(sends).toHaveLength(0);
      expect(readDeliveries((await convo(THIRD))!.knownFields).at(-1)).toMatchObject({ status: "suppressed", error: expect.stringMatching(/hasn't said/) });
    } finally {
      await removeBusinessNumber(THIRD, "PN_COEX_C");
      await getConversationStore().deleteConversationsByPrefix(THIRD, `wa:${THIRD}:${CUST}`);
    }
  });
  it("disconnected / token expired → no send; a Meta 401/190 on send marks the number token_expired", async () => {
    setRoleSendersOverride({ customer: () => ({ channel: "whatsapp", mode: "live", send: async () => Promise.reject(new Error("WhatsApp send failed (401 / 190)")) }), owner: () => ({ channel: "whatsapp", mode: "dry_run", send: async () => ({}) }), founder: () => ({ channel: "whatsapp", mode: "dry_run", send: async () => ({}) }) });
    await customer("Hello");
    expect((await listBusinessNumbers(BIZ)).find((n) => n.phoneNumberId === PN_A)?.status).toBe("token_expired");
    expect((await customerWhatsappState(BIZ)).state).toBe("BLOCKED_DISCONNECTED");
  });
});

describe("the owner sees it in plain words, and gives it back", () => {
  it("“who is with an employee?”, “why isn't BARRY answering this customer?”, “תחזיר את השיחה עם X לברי”", async () => {
    await customer("Hello");
    await employee("I'm on it");
    const graph = resolveBusinessGraph(BIZ);
    const ask = (text: string, key: string) => executeOwnerCommand({ graph, source: "web", actor: { kind: "web" }, key, text, lang: "he" });
    const team = await ask("מי נמצא כרגע אצל עובד?", `k-${++seq}`);
    expect(team.reply.text).toMatch(/Dana — מישהו מהצוות ענה מהוואטסאפ של העסק/);
    expect(team.reply.text).not.toMatch(/echo|webhook|holder|lease|Cloud API/i);
    expect(interpretCommand("למה ברי לא עונה ללקוח הזה?").intent).toEqual({ kind: "query", topic: "customer" });
    const back = await ask("תחזיר את השיחה עם Dana לברי", `k-${++seq}`);
    expect(back.record.intent).toMatchObject({ kind: "conversation_giveback", subject: "Dana" });
    expect(await holder()).toBe("barry");
  });
});

describe("Design Partner readiness for this operating model", () => {
  it("team replies from the app + coexistence verified → ready items; unverified → BLOCKED; unanswered → BLOCKED", async () => {
    const graph = resolveBusinessGraph(BIZ);
    const item = async (id: string) => (await launchChecklist(graph, { controls: { ...DEFAULT_CONTROLS }, conversations: [] })).items.find((i) => i.id === id);
    expect(await item("channel.customer_whatsapp")).toMatchObject({ status: "ready", title: expect.stringMatching(/CONNECTED_WITH_HUMAN_COEXISTENCE/) });
    expect(await item("channel.team_takeover")).toMatchObject({ status: "ready" });
    await registerBusinessNumber({ businessId: BIZ, phoneNumberId: PN_A, wabaId: "WABA_A", coexistence: "unavailable", by: "test" });
    expect(await item("channel.customer_whatsapp")).toMatchObject({ title: expect.stringMatching(/CONNECTED_API_ONLY/) });
    expect(await item("channel.team_takeover")).toMatchObject({ status: "blocked" });
    await setTeamRepliesInApp(BIZ, PN_A, false, "test");
    expect(await item("channel.team_takeover")).toMatchObject({ status: "ready" });
    await setNumberStatus(BIZ, PN_A, "disconnected", "test", "Meta disconnected");
    expect(await item("channel.customer_whatsapp")).toMatchObject({ status: "blocked", title: expect.stringMatching(/BLOCKED_DISCONNECTED/) });
  });
});
