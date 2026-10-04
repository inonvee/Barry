import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { setReasonerForTests } from "@/lib/reasoner";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { updateConversation } from "@/lib/state/update";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { processInbound, type OutboundSender } from "@/lib/channels/gateway";
import { parseWebhook } from "@/lib/channels/whatsapp";
import { applyControlChange, listControlAudit, loadControls, resetControlsCacheForTests } from "@/lib/hq/controls";
import { operatingMode } from "@/lib/runtime/operating-mode";
import { createHandoff } from "@/lib/runtime/handoff";
import { readControl, readControlLog } from "@/lib/runtime/control";
import { setBusinessGraphResolverForTests } from "@/lib/business-graph-repository";
import { getBusinessGraph } from "@/lib/fixtures";
import type { BusinessGraph } from "@/lib/business-graph";
import { createLinkCode } from "@/lib/owner-channel/identity";
import { processOwnerInbound } from "@/lib/owner-channel/gateway";
import type { OwnerInbound, OwnerOutbound, OwnerSender } from "@/lib/owner-channel/transport";
import { listCommandRecords } from "@/lib/owner/command-service";
import { interpretCommand, type CommandIntent } from "@/lib/owner/command";
import { setOwnerModelForTests } from "@/lib/owner/command-llm";
import { setOwnerReplySenderForTests } from "@/lib/owner/human-control";
import { listBriefs, notifyOwnerAttention, notifyOwnerDecisions, dailyBriefText } from "@/lib/owner/briefs";
import { getOwnerWorkspace } from "@/lib/owner/service";
import { CONTEXT_TTL_MS } from "@/lib/owner/session";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * OWNER WHATSAPP V1 — the owner runs the business from WhatsApp through the SAME services as the web:
 * the same approvals (exact revision, single use), the same handoff state, the same operating mode, the same
 * money truth, the same audit. The language layer only interprets; it never decides or mutates. Short replies
 * resolve only against fresh, unambiguous context. Nothing really leaves the test (dry-run / capturing senders).
 */

const PHONE = "972501234567";
const STRANGER = "972507654321";
let seq = 0;
const mid = () => `wamid.OWA${Date.now()}${seq++}`;
const msg = (text: string, from = PHONE, id = mid()): OwnerInbound => ({ channel: "whatsapp", messageId: id, channelUserId: from, verifiedIdentifier: `phone:${from}`, receivedAt: new Date().toISOString(), text });
const tap = (actionId: string, from = PHONE, id = mid()): OwnerInbound => ({ channel: "whatsapp", messageId: id, channelUserId: from, verifiedIdentifier: `phone:${from}`, receivedAt: new Date().toISOString(), actionId });

/** The owner line in test mode: what BARRY would send is recorded as a dry run — nothing leaves. */
function ownerLine(mode: "live" | "dry_run" = "dry_run"): OwnerSender & { sent: { to: string; m: OwnerOutbound }[] } {
  const sent: { to: string; m: OwnerOutbound }[] = [];
  return { channel: "whatsapp", mode, sent, send: async (to, m) => (sent.push({ to, m }), { providerMessageId: `own_${sent.length}` }) };
}
/** The customer channel in dry-run: BARRY's and the owner's customer messages are recorded, never sent. */
function customerLine(): OutboundSender & { calls: number } {
  const s = { channel: "whatsapp" as const, mode: "dry_run" as const, calls: 0, send: async () => ((s.calls += 1), {}) };
  return s;
}

const SCRIPT: Record<string, object> = {
  "the midnight dress": { commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true },
  "add it in M": { commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true },
  "could you ask the owner to approve 10% off this dress?": { constraints: { discountPct: 10 }, advancesTransaction: true, asks: [{ ask: "10% off this dress", kind: "change", coveredByThisIR: true }] },
};

const graphs = new Map<string, BusinessGraph>();
const disposers: (() => void)[] = [];
beforeEach(() => {
  resetControlsCacheForTests();
  setLockStoreForTests(new MemoryLockStore());
  setInboxStoreForTests(new MemoryInboxStore());
});
afterEach(() => {
  setReasonerForTests(undefined);
  setOwnerModelForTests(undefined);
  setOwnerReplySenderForTests(undefined);
  setLockStoreForTests(undefined);
  setInboxStoreForTests(undefined);
  resetControlsCacheForTests();
  while (disposers.length) disposers.pop()!();
  graphs.clear();
  setBusinessGraphResolverForTests(undefined);
});

function tenant() {
  const r = isolatedRetailer();
  disposers.push(r.dispose);
  graphs.set(r.g.business.id, r.g);
  setBusinessGraphResolverForTests((id) => graphs.get(id) ?? getBusinessGraph(id));
  const model = new ScriptedModel(() => undefined);
  model.plan = (ctx) => SCRIPT[ctx.customerMessage ?? ""] as never;
  setReasonerForTests(model);
  // No language model in this suite unless a test installs one: the deterministic path must stand alone.
  setOwnerModelForTests({ interpret: null, draft: null });
  const customers = customerLine();
  setOwnerReplySenderForTests(() => customers);
  const line = ownerLine("live"); // a capturing fake: nothing leaves the test
  const owner = async (text: string, from = PHONE) => {
    const r = await processOwnerInbound(msg(text, from), line, { businessIds: [r_.g.business.id] });
    return { r, text: line.sent.at(-1)?.m.text ?? "", m: line.sent.at(-1)?.m };
  };
  const r_ = r;
  const say = (id: string, text: string) => handleCustomerMessage(r.g, id, "c", text);
  return { ...r, model, say, owner, line, customers, ids: [r.g.business.id] };
}
type T = ReturnType<typeof tenant>;

async function link(t: T, phone = PHONE) {
  const { code } = await createLinkCode(t.g.business.id);
  expect((await processOwnerInbound(msg(`LINK ${code}`, phone), t.line, { businessIds: t.ids })).status).toBe("linked");
}
async function named(id: string, name: string) {
  await updateConversation(id, (s) => void (s.knownFields.name = name));
}
async function discountRequest(t: T, name: string) {
  const id = conv("cart");
  await t.say(id, "the midnight dress");
  await t.say(id, "add it in M");
  await t.say(id, "could you ask the owner to approve 10% off this dress?");
  await named(id, name);
  return id;
}
const approvalOf = async (t: T, conversationId: string) => (await getBackend().listApprovals(t.g.business.id)).find((a) => a.conversationId === conversationId)!;
/** A WhatsApp customer whose conversation BARRY handed to a person. */
async function needsHuman(t: T, name: string) {
  const phone = `9725${Math.floor(Math.random() * 1e8)}`;
  const id = `wa:${t.g.business.id}:${phone}`;
  let n = 0;
  const inbound = (text: string) => ({ businessId: t.g.business.id, conversationId: id, customerId: `wa:${phone}`, identity: { channel: "whatsapp" as const, channelUserId: phone, verifiedIdentifier: `phone:${phone}` }, text, receivedAt: new Date().toISOString(), inboundId: `wamid.cust.${phone}.${++n}` });
  await processInbound(inbound("hi, is anyone there?"), t.customers);
  await named(id, name);
  await updateConversation(id, (s) => createHandoff(t.g, s, { trigger: "customer_asked", reason: "wants a person" }));
  return { id, phone, inbound };
}

// ── Identity and separation ──────────────────────────────────────────────────────────────────────

describe("owner identity — only the verified owner reaches the owner command path", () => {
  it("the verified owner is recognized; an unknown phone can't issue commands; nothing runs for it", async () => {
    const t = tenant();
    await link(t);
    const ok = await t.owner("what needs me?");
    expect(ok.r.status).toBe("processed");
    const before = (await listCommandRecords(t.g.business.id)).length;
    const stranger = await t.owner("pause BARRY", STRANGER);
    expect(stranger.r.status).toBe("rejected");
    expect(stranger.text).not.toMatch(/paused/i);
    expect(operatingMode(await loadControls(t.g.business.id))).not.toBe("paused");
    expect((await listCommandRecords(t.g.business.id)).length).toBe(before);
  });

  it("customer and owner paths are separate: a customer line never routes to the owner path (even the owner's own number)", () => {
    const payload = (pn: string, body: string) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: pn }, messages: [{ id: `m-${pn}-${body}`, from: PHONE, type: "text", text: { body } }] } }] }] });
    const routes = { pn_customers: "fashion-retailer" };
    for (const body of ["approve", "pause BARRY", "תאשר"]) {
      const c = parseWebhook(payload("pn_customers", body), routes, ["pn_owner"]);
      expect(c.owner).toHaveLength(0);
      expect(c.messages).toHaveLength(1);
      const o = parseWebhook(payload("pn_owner", body), routes, ["pn_owner"]);
      expect(o.messages).toHaveLength(0);
      expect(o.owner).toHaveLength(1);
    }
  });

  it("an owner command never runs as a customer message: customer text on the customer line is a customer turn, never an approval", async () => {
    const t = tenant();
    const id = await discountRequest(t, "Dana");
    await link(t);
    await t.say(id, "approve");
    expect((await approvalOf(t, id)).status).toBe("pending");
  });
});

// ── Language ────────────────────────────────────────────────────────────────────────────────────

describe("natural Hebrew and English map to the same typed intents", () => {
  const cases: [string, Partial<CommandIntent>][] = [
    ["What needs me?", { kind: "query", topic: "needs_you" }],
    ["מה צריך אותי?", { kind: "query", topic: "needs_you" }],
    ["anything urgent?", { kind: "query", topic: "needs_you" }],
    ["יש משהו דחוף?", { kind: "query", topic: "needs_you" }],
    ["What is BARRY handling?", { kind: "query", topic: "working" }],
    ["מה ברי עושה עכשיו?", { kind: "query", topic: "working" }],
    ["What are we waiting on?", { kind: "query", topic: "waiting" }],
    ["על מה אנחנו מחכים?", { kind: "query", topic: "waiting" }],
    ["How much came in today?", { kind: "query", topic: "money" }],
    ["כמה נכנס היום?", { kind: "query", topic: "money" }],
    ["What money is stuck?", { kind: "query", topic: "money", money: "stuck" }],
    ["יש כסף תקוע?", { kind: "query", topic: "money", money: "stuck" }],
    ["What is awaiting payment?", { kind: "query", topic: "money", money: "awaiting" }],
    ["Which payments failed?", { kind: "query", topic: "money", money: "failed" }],
    ["approve", { kind: "approval_response", decision: "approve" }],
    ["תאשר", { kind: "approval_response", decision: "approve" }],
    ["yes", { kind: "affirm" }],
    ["כן", { kind: "affirm" }],
    ["decline", { kind: "approval_response", decision: "decline" }],
    ["don't do it", { kind: "approval_response", decision: "decline" }],
    ["אל תאשר", { kind: "approval_response", decision: "decline" }],
    ["what is this approval for?", { kind: "approval_explain" }],
    ["I'll take it", { kind: "conversation_takeover" }],
    ["אני לוקח את השיחה", { kind: "conversation_takeover" }],
    ["tell her I'm checking and will get back to her", { kind: "conversation_reply", exact: false }],
    ["תענה לה שאני בודק וחוזר אליה", { kind: "conversation_reply", exact: false }],
    ["tell Dana: I'm checking now", { kind: "conversation_reply", subject: "Dana", exact: true, text: "I'm checking now" }],
    ["give it back to BARRY", { kind: "conversation_giveback" }],
    ["תחזיר לברי", { kind: "conversation_giveback" }],
    ["pause BARRY", { kind: "mode_change", to: "paused" }],
    ["תעצור הכל", { kind: "mode_change", to: "paused" }],
    ["resume BARRY", { kind: "mode_change", to: "resumed" }],
    ["תחזיר אותו לעבוד", { kind: "mode_change", to: "resumed" }],
    ["what mode are we in?", { kind: "mode_query" }],
    ["באיזה מצב אנחנו?", { kind: "mode_query" }],
  ];
  it.each(cases)("%s", (text, intent) => {
    expect(interpretCommand(text, "whatsapp").intent).toMatchObject(intent);
  });

  it("the language model only fills gaps, into a closed set — it can never approve, decline or confirm", async () => {
    const t = tenant();
    const id = await discountRequest(t, "Dana");
    await link(t);
    // A model that "wants" to approve: whatever it returns is outside the closed set it may produce.
    setOwnerModelForTests({ interpret: async () => ({ kind: "approval_response", decision: "approve" }) as never, draft: null });
    await t.owner("what needs me?");
    // Unrecognised wording → the model is consulted; even so the request is NOT decided by it (the real adapter
    // can't produce a decision at all; this proves the service's own guard).
    const r = await t.owner("hmm sure whatever you think, sounds fine I guess");
    expect(r.r.status).toBe("processed");
    const rec = (await listCommandRecords(t.g.business.id))[0];
    expect(rec.intent?.kind).toBe("query");
    expect(rec.trace.some((x) => x.step === "interpretation" && x.outcome === "blocked" && /not allowed from a model/.test(x.detail))).toBe(true);
    expect((await approvalOf(t, id)).status).toBe("pending");
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────

describe("reads — from the owner read model only", () => {
  it("what needs me / what is BARRY handling / what are we waiting on — English and Hebrew", async () => {
    const t = tenant();
    await discountRequest(t, "Dana");
    await link(t);
    const needs = await t.owner("What needs me?");
    expect(needs.text).toMatch(/Dana/);
    expect(needs.text).toMatch(/Why you/);
    expect(needs.m?.actions?.map((a) => a.title)).toEqual(["Approve", "Decline"]);
    const he = await t.owner("מה צריך אותי?");
    expect(he.text).toMatch(/מחכה לך|מחכים לך/);
    const handling = await t.owner("What is BARRY handling?");
    expect(handling.text).toMatch(/Right now:|Nothing open/);
    const waiting = await t.owner("What are we waiting on?");
    expect(waiting.text).toMatch(/Your approval: Dana/);
    const waitingHe = await t.owner("על מה אנחנו מחכים?");
    expect(waitingHe.text).toMatch(/האישור שלך: Dana/);
  });

  it("money is truthful: nothing paid → nothing claimed; stuck / awaiting / failed answer from records only", async () => {
    const t = tenant();
    await link(t);
    const today = await t.owner("How much came in today?");
    expect(today.text).toMatch(/nothing yet/);
    const stuck = await t.owner("What money is stuck?");
    expect(stuck.text).toMatch(/No money is stuck/);
    const awaiting = await t.owner("What is awaiting payment?");
    expect(awaiting.text).toMatch(/Nothing is awaiting payment/);
    const failed = await t.owner("What failed with payments?");
    expect(failed.text).toMatch(/Nothing failed/);
    const he = await t.owner("כמה נכנס היום?");
    expect(he.text).toMatch(/עוד כלום/);
    for (const x of [today, stuck, awaiting, failed, he]) expect(x.text).not.toMatch(/recovered|הוחזר/);
  });
});

// ── Decisions ───────────────────────────────────────────────────────────────────────────────────

describe("approvals — the same exact-revision, single-use path as the web", () => {
  it("“yes” right after the request was shown approves exactly that request — once", async () => {
    const t = tenant();
    const id = await discountRequest(t, "Dana");
    await link(t);
    await t.owner("what needs me?");
    const yes = await t.owner("yes");
    expect(yes.text).toMatch(/Approved/);
    expect((await approvalOf(t, id)).status).toBe("approved");
    // Another "yes" has nothing in context any more → nothing happens.
    const again = await t.owner("yes");
    expect(again.text).toMatch(/didn't do anything|not sure/);
  });

  it("Hebrew decline (“אל תאשר”) against the request in context", async () => {
    const t = tenant();
    const id = await discountRequest(t, "Dana");
    await link(t);
    await t.owner("מה צריך אותי?");
    const no = await t.owner("אל תאשר");
    expect(no.text).toMatch(/נדחה/);
    expect((await approvalOf(t, id)).status).toBe("declined");
  });

  it("ambiguous: two requests and a bare “approve” with nothing in context → shown and asked, never guessed", async () => {
    const t = tenant();
    const a = await discountRequest(t, "Dana");
    const b = await discountRequest(t, "Maya");
    await link(t);
    const r = await t.owner("approve");
    expect(r.text).toMatch(/2 requests are waiting/);
    expect(r.text).toMatch(/won't guess/);
    expect((await approvalOf(t, a)).status).toBe("pending");
    expect((await approvalOf(t, b)).status).toBe("pending");
    // Naming a customer whose request was never shown SHOWS it (and makes it the context) — it doesn't decide it.
    const shown = await t.owner("approve Maya");
    expect(shown.text).toMatch(/Maya/);
    expect((await approvalOf(t, b)).status).toBe("pending");
    await t.owner("approve");
    expect((await approvalOf(t, b)).status).toBe("approved");
    expect((await approvalOf(t, a)).status).toBe("pending");
  });

  it("a new unrelated request clears the context — a later “yes” can't approve the old request", async () => {
    const t = tenant();
    const id = await discountRequest(t, "Dana");
    await link(t);
    await t.owner("what needs me?");
    await t.owner("how much came in today?");
    const yes = await t.owner("yes");
    expect(yes.text).toMatch(/didn't do anything|not sure/);
    expect((await approvalOf(t, id)).status).toBe("pending");
  });

  it("old context expires — a “yes” after the context window does nothing", async () => {
    const t = tenant();
    const id = await discountRequest(t, "Dana");
    await link(t);
    await t.owner("what needs me?");
    const late = new Date(Date.now() + CONTEXT_TTL_MS + 60_000);
    await processOwnerInbound(msg("yes"), t.line, { businessIds: t.ids, now: late });
    expect((await approvalOf(t, id)).status).toBe("pending");
  });

  it("“what is this for?” explains the request in context without deciding it", async () => {
    const t = tenant();
    const id = await discountRequest(t, "Dana");
    await link(t);
    await t.owner("what needs me?");
    const why = await t.owner("what is this approval for?");
    expect(why.text).toMatch(/10%/);
    expect(why.text).toMatch(/If you approve/);
    expect((await approvalOf(t, id)).status).toBe("pending");
    // …and the context still points at it.
    await t.owner("approve");
    expect((await approvalOf(t, id)).status).toBe("approved");
  });

  it("a duplicate owner inbound id is idempotent: the decision runs once, the stored reply is returned", async () => {
    const t = tenant();
    const id = await discountRequest(t, "Dana");
    await link(t);
    await t.owner("what needs me?");
    const m = msg("approve");
    const first = await processOwnerInbound(m, t.line, { businessIds: t.ids });
    const second = await processOwnerInbound(m, t.line, { businessIds: t.ids });
    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");
    expect((await approvalOf(t, id)).status).toBe("approved");
    const decided = (await listCommandRecords(t.g.business.id)).filter((c) => c.trace.some((s) => s.step === "approval" && s.outcome === "ok"));
    expect(decided).toHaveLength(1);
  });
});

// ── Conversation control ────────────────────────────────────────────────────────────────────────

describe("customer conversation control — the existing handoff service", () => {
  it("take over → a customer message while the owner holds it is kept, not answered → owner reply (draft, confirm, send) → give back", async () => {
    const t = tenant();
    const c = await needsHuman(t, "Noa");
    await link(t);
    const take = await t.owner("I'll take it");
    expect(take.text).toMatch(/You have the conversation with Noa/);
    let state = (await getConversationStore().get(c.id))!;
    expect(readControl(state)).toMatchObject({ holder: "human", by: expect.stringMatching(/^the owner on WhatsApp/) });

    // The customer writes while the owner holds the conversation: stored, BARRY stays silent.
    const barryBefore = state.messages.filter((m) => m.role === "barry").length;
    const held = await processInbound(c.inbound("hello??"), t.customers);
    expect(held.status).not.toBe("processed");
    state = (await getConversationStore().get(c.id))!;
    expect(state.messages.at(-1)).toMatchObject({ role: "customer", content: "hello??" });
    expect(state.messages.filter((m) => m.role === "barry").length).toBe(barryBefore);

    // Natural instruction → a draft shown first; nothing sent yet.
    const draft = await t.owner("tell her I'm checking and will get back to her");
    expect(draft.text).toMatch(/I'll send Noa/);
    expect(draft.m?.actions?.map((a) => a.title)).toEqual(["Send", "Don't send"]);
    expect((await getConversationStore().get(c.id))!.messages.some((m) => m.role === "owner")).toBe(false);
    const sent = await t.owner("send it");
    expect(sent.text).toMatch(/Test mode — recorded in Noa's conversation but NOT sent/);
    state = (await getConversationStore().get(c.id))!;
    const own = state.messages.filter((m) => m.role === "owner");
    expect(own).toHaveLength(1);
    expect(own[0].author).toMatch(/^the owner on WhatsApp/);
    expect(t.customers.calls).toBe(0); // dry run: nothing left

    // Tapping the old Send button again never sends twice.
    await processOwnerInbound(tap(draft.m!.actions![0].id), t.line, { businessIds: t.ids });
    expect((await getConversationStore().get(c.id))!.messages.filter((m) => m.role === "owner")).toHaveLength(1);

    const back = await t.owner("תחזיר לברי");
    expect(back.text).toMatch(/חזרה ל־BARRY/);
    state = (await getConversationStore().get(c.id))!;
    expect(readControl(state).holder).toBe("barry");
    const log = readControlLog(state).map((e) => `${e.from}->${e.to}`);
    expect(log).toEqual(["barry->human", "human->barry"]);
  });

  it("Hebrew exact reply after a colon is sent as written; “don't send” discards a draft", async () => {
    const t = tenant();
    const c = await needsHuman(t, "Noa");
    await link(t);
    await t.owner("אני לוקח את השיחה");
    await t.owner("תענה לה שאני בודק");
    const cancel = await t.owner("לא");
    expect(cancel.text).toMatch(/לא נשלח/);
    expect((await getConversationStore().get(c.id))!.messages.some((m) => m.role === "owner")).toBe(false);
    await t.owner("תענה לNoa: בודק וחוזר אלייך");
    const own = (await getConversationStore().get(c.id))!.messages.filter((m) => m.role === "owner");
    expect(own.map((m) => m.content)).toEqual(["בודק וחוזר אלייך"]);
  });

  it("an ambiguous conversation reference asks — it never picks one", async () => {
    const t = tenant();
    const a = await needsHuman(t, "Noa");
    const b = await needsHuman(t, "Lia");
    await link(t);
    const r = await t.owner("I'll take it");
    expect(r.text).toMatch(/Which customer\?/);
    for (const c of [a, b]) expect(readControl((await getConversationStore().get(c.id))!).by).toBe("barry");
    await t.owner("I'll take it with Lia");
    expect(readControl((await getConversationStore().get(b.id))!)).toMatchObject({ holder: "human", by: expect.stringMatching(/owner on WhatsApp/) });
  });

  it("the web sees the same state: taking over on WhatsApp shows as held in the owner read model", async () => {
    const t = tenant();
    const c = await needsHuman(t, "Noa");
    await link(t);
    await t.owner("I'll take it");
    const ws = await getOwnerWorkspace(t.g);
    expect(ws.conversations.find((x) => x.id === c.id)?.attention).toContain("handoff_open");
  });
});

// ── Operating control ───────────────────────────────────────────────────────────────────────────

describe("operating control — the same owner pause as the web", () => {
  it("pause → a customer message is stored, not answered → mode query → resume", async () => {
    const t = tenant();
    const c = await needsHuman(t, "Noa");
    await link(t);
    await t.owner("I'll take it");
    await t.owner("give it back to BARRY");
    const pause = await t.owner("תעצור הכל");
    expect(pause.text).toMatch(/הושהה/);
    expect(operatingMode(await loadControls(t.g.business.id))).toBe("paused");
    const before = (await getConversationStore().get(c.id))!.messages.filter((m) => m.role === "barry").length;
    await processInbound(c.inbound("are you there?"), t.customers);
    const state = (await getConversationStore().get(c.id))!;
    expect(state.messages.at(-1)).toMatchObject({ role: "customer", content: "are you there?" });
    expect(state.messages.filter((m) => m.role === "barry").length).toBe(before);
    const mode = await t.owner("what mode are we in?");
    expect(mode.text).toMatch(/Paused — by you/);
    const resume = await t.owner("תחזיר אותו לעבוד");
    expect(resume.text).toMatch(/חזרנו/);
    expect(operatingMode(await loadControls(t.g.business.id))).not.toBe("paused");
  });

  it("a founder pause can't be overridden by the owner", async () => {
    const t = tenant();
    await link(t);
    await applyControlChange(t.g.business.id, { pausedBusiness: true }, { by: "founder", reason: "incident" });
    const r = await t.owner("resume BARRY");
    expect(r.text).toMatch(/BARRY team paused/);
    expect(operatingMode(await loadControls(t.g.business.id))).toBe("paused");
    const mode = await t.owner("what mode are we in?");
    expect(mode.text).toMatch(/Paused by the BARRY team/);
  });

  it("audit: every owner mutation is attributed and recorded (controls audit, handoff log, command trace)", async () => {
    const t = tenant();
    const id = await discountRequest(t, "Dana");
    const c = await needsHuman(t, "Noa");
    await link(t);
    await t.owner("what needs me?");
    await t.owner("approve Dana");
    await t.owner("I'll take it with Noa");
    await t.owner("tell Noa: on it");
    await t.owner("give it back to BARRY");
    await t.owner("pause BARRY");
    await t.owner("resume BARRY");
    const audit = await listControlAudit(t.g.business.id);
    expect(audit.filter((a) => /owner on WhatsApp/.test(a.by)).length).toBe(2);
    const log = readControlLog((await getConversationStore().get(c.id))!);
    expect(log.every((e) => e.by === "barry" || /owner on WhatsApp/.test(e.by))).toBe(true);
    expect((await approvalOf(t, id)).status).toBe("approved");
    const records = await listCommandRecords(t.g.business.id);
    const mutations = records.filter((r) => ["approval_response", "conversation_takeover", "conversation_reply", "conversation_giveback", "mode_change"].includes(r.intent?.kind ?? ""));
    expect(mutations).toHaveLength(6);
    for (const r of mutations) {
      expect(r.actor).toMatch(/owner on WhatsApp/);
      expect(r.trace.some((s) => s.step === "execution" || s.step === "approval")).toBe(true);
    }
  });
});

// ── Notifications ───────────────────────────────────────────────────────────────────────────────

describe("proactive notifications — V1 categories, coalesced, never twice, no real sends in dry run", () => {
  it("a customer who needs a person is announced once; a second one arrives as one new message with only the new item", async () => {
    const t = tenant();
    await applyControlChange(t.g.business.id, { mode: "supervised" }, { by: "founder", reason: "test" });
    await link(t);
    await needsHuman(t, "Noa");
    const line = ownerLine("dry_run");
    const first = await notifyOwnerAttention(t.g, { sender: line });
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe("dry_run");
    expect(first[0].text).toMatch(/Noa needs a person/);
    expect(line.sent).toHaveLength(0); // dry run: nothing left
    expect(await notifyOwnerAttention(t.g, { sender: line })).toHaveLength(0);
    await needsHuman(t, "Lia");
    const second = await notifyOwnerAttention(t.g, { sender: line });
    expect(second).toHaveLength(1);
    expect(second[0].text).toMatch(/Lia/);
    expect(second[0].text).not.toMatch(/Noa/);
  });

  it("practice (simulator) businesses never notify the owner line; decisions are announced once per revision", async () => {
    const t = tenant();
    await needsHuman(t, "Noa");
    await discountRequest(t, "Dana");
    await link(t);
    expect(await notifyOwnerAttention(t.g, { sender: ownerLine() })).toHaveLength(0);
    const line = ownerLine("dry_run");
    const d1 = await notifyOwnerDecisions(t.g, { sender: line });
    expect(d1).toHaveLength(1);
    expect(d1[0].status).toBe("dry_run");
    expect(await notifyOwnerDecisions(t.g, { sender: line })).toHaveLength(0);
    expect(line.sent).toHaveLength(0);
  });

  it("a decision notice becomes the owner's context: “approve” then decides exactly that request", async () => {
    const t = tenant();
    const id = await discountRequest(t, "Dana");
    await link(t);
    await notifyOwnerDecisions(t.g, { sender: ownerLine("dry_run") });
    await t.owner("approve");
    expect((await approvalOf(t, id)).status).toBe("approved");
  });

  it("outside the 24-hour window the notice is recorded as blocked, truthfully, and not retried as a duplicate", async () => {
    const t = tenant();
    await discountRequest(t, "Dana");
    await link(t);
    const later = new Date(Date.now() + 25 * 3600_000);
    const recs = await notifyOwnerDecisions(t.g, { sender: ownerLine("live"), now: later });
    expect(recs.map((r) => r.status)).toEqual(["blocked"]);
    expect(recs[0].reason).toMatch(/24-hour window/);
    expect(await notifyOwnerDecisions(t.g, { sender: ownerLine("live"), now: later })).toHaveLength(0);
    expect((await listBriefs(t.g.business.id)).filter((b) => b.kind === "decision")).toHaveLength(1);
  });

  it("the daily brief says nothing when nothing happened (no fake activity) and speaks Hebrew to a Hebrew owner", async () => {
    const t = tenant();
    const ws = await getOwnerWorkspace(t.g);
    expect(dailyBriefText(ws, 0)).toBeUndefined();
    await discountRequest(t, "Dana");
    const ws2 = await getOwnerWorkspace(t.g);
    expect(dailyBriefText(ws2, 0)).toMatch(/Dana needs you/);
    expect(dailyBriefText(ws2, 0, "he")).toMatch(/Dana מחכה לך/);
  });
});
