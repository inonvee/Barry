import { afterEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { setReasonerForTests } from "@/lib/reasoner";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { resetControlsCacheForTests, applyControlChange } from "@/lib/hq/controls";
import { setBusinessGraphResolverForTests } from "@/lib/business-graph-repository";
import { getBusinessGraph } from "@/lib/fixtures";
import type { BusinessGraph } from "@/lib/business-graph";
import { parseWebhook } from "@/lib/channels/whatsapp";
import { createLinkCode, listOwnerIdentities, resolveOwnerIdentity, revokeOwnerIdentity } from "@/lib/owner-channel/identity";
import { processOwnerInbound } from "@/lib/owner-channel/gateway";
import type { OwnerInbound, OwnerOutbound, OwnerSender } from "@/lib/owner-channel/transport";
import { executeOwnerCommand, listCommandRecords, ownerLink, parseAction } from "@/lib/owner/command-service";
import { interpretCommand } from "@/lib/owner/command";
import { listOperations, setOperationSendersForTests } from "@/lib/owner/operations";
import type { OutboundSender } from "@/lib/channels/gateway";
import { notifyOwnerDecisions, listBriefs } from "@/lib/owner/briefs";
import { ownerHeldKeys } from "@/lib/operator/holds";
import { listAttempts } from "@/lib/operator/attempts";
import { runObligationExecutor } from "@/lib/operator/executor";
import { getOwnerWorkspace } from "@/lib/owner/service";
import { selectPlan } from "@/lib/commercial/account";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * THE OWNER COMMAND CHANNEL — semantic invariants, not phrase lists:
 *   - only a verified, actively linked owner identity reaches the owner path, for exactly its business;
 *   - web and WhatsApp share one command model and one service;
 *   - batch work runs only on a grounded cohort, through the bounded executor, within plan + rules;
 *   - approvals run once, only against the exact current request revision the owner was shown;
 *   - everything is idempotent by provider message id / action, auditable, and leaks nothing.
 */

const ENV = ["BARRY_OWNER_TOKENS", "BARRY_OWNER_TOKEN", "BARRY_PUBLIC_URL", "VERCEL_URL"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const disposers: (() => void)[] = [];
afterEach(() => {
  setOperationSendersForTests(undefined);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setReasonerForTests(undefined);
  resetControlsCacheForTests();
  while (disposers.length) disposers.pop()!();
  graphs.clear();
  setBusinessGraphResolverForTests(undefined);
});

// Isolated test tenants resolve by id like real businesses do (the owner gateway resolves the linked business).
const graphs = new Map<string, BusinessGraph>();

const PHONE = "972501112233";
const OTHER = "972509998877";
let seq = 0;
const mid = () => `wamid.TEST${Date.now()}${seq++}`;
const msg = (text: string, from = PHONE, id = mid()): OwnerInbound => ({ channel: "whatsapp", messageId: id, channelUserId: from, verifiedIdentifier: `phone:${from}`, receivedAt: new Date().toISOString(), text });
const tap = (actionId: string, from = PHONE, id = mid()): OwnerInbound => ({ channel: "whatsapp", messageId: id, channelUserId: from, verifiedIdentifier: `phone:${from}`, receivedAt: new Date().toISOString(), actionId });

/** A "live" sender that captures what would leave — nothing actually leaves the test. */
function capture(): OwnerSender & { sent: { to: string; m: OwnerOutbound }[] } {
  const sent: { to: string; m: OwnerOutbound }[] = [];
  return { channel: "whatsapp", mode: "live", sent, send: async (to, m) => (sent.push({ to, m }), { providerMessageId: `out_${sent.length}` }) };
}

const SCRIPT: Record<string, object> = {
  "the midnight dress": { commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true },
  "add it in M": { commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true },
  "could you ask the owner to approve 10% off this dress?": { constraints: { discountPct: 10 }, advancesTransaction: true, asks: [{ ask: "10% off this dress", kind: "change", coveredByThisIR: true }] },
};

/** A "live" CUSTOMER sender that captures what would leave (the real-send path) — nothing leaves the test. */
function liveCustomers(): OutboundSender & { sent: { to: string; text: string }[] } {
  const sent: { to: string; text: string }[] = [];
  return { channel: "web", mode: "live", sent, send: async (to, text) => (sent.push({ to, text }), { providerMessageId: `cust_${sent.length}` }) };
}

function tenant() {
  const r = isolatedRetailer();
  disposers.push(r.dispose);
  graphs.set(r.g.business.id, r.g);
  setBusinessGraphResolverForTests((id) => graphs.get(id) ?? getBusinessGraph(id));
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  const say = async (id: string, text: string) => {
    model.plan = () => SCRIPT[text] as never;
    return handleCustomerMessage(r.g, id, "c", text);
  };
  return { ...r, say, ids: [r.g.business.id] };
}

async function cart(t: ReturnType<typeof tenant>) {
  const id = conv("cart");
  await t.say(id, "the midnight dress");
  await t.say(id, "add it in M");
  return id;
}

async function discountRequest(t: ReturnType<typeof tenant>) {
  const id = await cart(t);
  await t.say(id, "could you ask the owner to approve 10% off this dress?");
  return id;
}

async function link(t: ReturnType<typeof tenant>, phone = PHONE, sender: OwnerSender = capture()) {
  const { code } = await createLinkCode(t.g.business.id);
  const r = await processOwnerInbound(msg(`LINK ${code}`, phone), sender, { businessIds: t.ids });
  expect(r.status).toBe("linked");
  return code;
}

describe("owner identity: only an active, verified, tenant-bound link reaches the owner path", () => {
  it("an unregistered number (or a customer) gets a neutral line and nothing runs", async () => {
    const t = tenant();
    const s = capture();
    const r = await processOwnerInbound(msg("How much did we make today?", OTHER), s, { businessIds: t.ids });
    expect(r.status).toBe("rejected");
    expect(s.sent[0].m.text).toMatch(/isn't linked to a BARRY business/);
    expect(s.sent[0].m.text).not.toMatch(/₪|made|Rina/);
    expect(await listCommandRecords(t.g.business.id)).toEqual([]);
  });

  it("linking needs a code from a signed-in owner sent FROM the number; codes are single-use, expire, and an unverified sender can't link", async () => {
    const t = tenant();
    const { code } = await createLinkCode(t.g.business.id);
    expect((await processOwnerInbound({ ...msg(`LINK ${code}`), verifiedIdentifier: undefined }, capture(), { businessIds: t.ids })).status).toBe("rejected");
    expect((await processOwnerInbound(msg(`LINK ${code}`), capture(), { businessIds: t.ids })).status).toBe("linked");
    // Replayed by someone else: refused (the code is used).
    expect((await processOwnerInbound(msg(`LINK ${code}`, OTHER), capture(), { businessIds: t.ids })).status).toBe("rejected");
    const late = await createLinkCode(t.g.business.id);
    expect((await processOwnerInbound(msg(`LINK ${late.code}`, OTHER), capture(), { businessIds: t.ids, now: new Date(Date.now() + 16 * 60_000) })).status).toBe("rejected");
    const links = await listOwnerIdentities(t.g.business.id);
    expect(links).toHaveLength(1);
    expect(JSON.stringify(await getBackend().listOperatorRecords(t.g.business.id, "owner_link_code"))).not.toContain(code);
  });

  it("revoking stops the next message; rotating the owner token ends links made under the old one", async () => {
    const t = tenant();
    process.env.BARRY_OWNER_TOKENS = `${t.g.business.id}:first-owner-token-0001`;
    await link(t);
    const [l] = await listOwnerIdentities(t.g.business.id);
    expect((await resolveOwnerIdentity("whatsapp", PHONE, `phone:${PHONE}`, t.ids)).status).toBe("resolved");
    process.env.BARRY_OWNER_TOKENS = `${t.g.business.id}:rotated-owner-token-002`;
    expect(await resolveOwnerIdentity("whatsapp", PHONE, `phone:${PHONE}`, t.ids)).toMatchObject({ status: "inactive", detail: "access_changed" });
    process.env.BARRY_OWNER_TOKENS = `${t.g.business.id}:first-owner-token-0001`;
    await revokeOwnerIdentity(t.g.business.id, l.id, "test");
    const r = await processOwnerInbound(msg("Who needs me?"), capture(), { businessIds: t.ids });
    expect(r.status).toBe("rejected");
  });

  it("Owner A can't operate business B; an owner of two businesses is asked which — never guessed", async () => {
    const a = tenant();
    const b = tenant();
    const both = [a.g.business.id, b.g.business.id];
    await link(a);
    const only = await processOwnerInbound(msg("What are you working on?"), capture(), { businessIds: both });
    expect(only).toMatchObject({ status: "processed", businessId: a.g.business.id });
    expect((await listCommandRecords(b.g.business.id)).length).toBe(0);
    // Now the same number links B too → ambiguous.
    const { code } = await createLinkCode(b.g.business.id);
    await processOwnerInbound(msg(`LINK ${code}`), capture(), { businessIds: both });
    const s = capture();
    const first = msg("How much did we make today?");
    const ask = await processOwnerInbound(first, s, { businessIds: both });
    expect(ask.status).toBe("ask_business");
    expect(s.sent[0].m.actions?.map((x) => x.id.split(":")[1])).toEqual(both);
    expect((await listCommandRecords(b.g.business.id)).filter((c) => !c.key.startsWith("pending:"))).toHaveLength(0);
    const picked = await processOwnerInbound(tap(`biz:${b.g.business.id}:${first.messageId}`), capture(), { businessIds: both });
    expect(picked).toMatchObject({ status: "processed", businessId: b.g.business.id });
    if (picked.status === "processed") expect(picked.command.text).toBe("How much did we make today?");
  });

  it("owner lines and customer lines never mix at the adapter", () => {
    const payload = (pn: string) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: pn }, messages: [{ id: `m-${pn}`, from: PHONE, type: "text", text: { body: "who needs me?" } }] } }] }] });
    const routes = { pn_customer: "fashion-retailer" };
    const cust = parseWebhook(payload("pn_customer"), routes, ["pn_owner"]);
    expect(cust.messages).toHaveLength(1);
    expect(cust.owner).toHaveLength(0);
    const own = parseWebhook(payload("pn_owner"), routes, ["pn_owner"]);
    expect(own.owner).toHaveLength(1);
    expect(own.messages).toHaveLength(0);
    // A number configured as BOTH is a customer line only (the owner config is ignored for it).
    const both = parseWebhook(payload("pn_customer"), routes, ["pn_customer"]);
    expect(both.owner).toHaveLength(0);
  });
});

describe("one command model, one service: web and WhatsApp are the same thing", () => {
  it("the same words give the same intent on every surface; transport never changes behavior", () => {
    for (const text of ["Recover everyone who abandoned a cart today.", "Who needs me right now?", "Stop the recovery campaign.", "Don't offer more than 5% today.", "What happened with Maya?", "How much did we make today?"]) {
      expect(interpretCommand(text, "whatsapp").intent).toEqual(interpretCommand(text, "web").intent);
    }
    expect(interpretCommand("Recover everyone who abandoned a cart today.").intent).toEqual({ kind: "operation_request", workflow: "abandoned_checkout_recovery", scope: "today" });
    expect(interpretCommand("Follow up with everyone who hasn't paid.").intent).toMatchObject({ kind: "operation_request", workflow: "unpaid_payment_followup" });
    expect(interpretCommand("Don't offer more than 5% today.").intent.kind).toBe("policy_change_request");
    expect(interpretCommand("Stop the recovery campaign.").intent.kind).toBe("operation_stop");
    expect(interpretCommand("Don't message anyone else.").intent).toMatchObject({ kind: "operation_stop", everything: true });
    expect(interpretCommand("Did Maya pay?").intent).toEqual({ kind: "query", topic: "customer", subject: "Maya" });
    expect(interpretCommand("What happened with the abandoned carts?").intent).toMatchObject({ kind: "query", topic: "operation", workflow: "abandoned_checkout_recovery" });
    expect(interpretCommand("Send a campaign to all my customers").intent.kind).toBe("unsupported");
  });

  it("reads answer from records only: money keeps verified / pending / test apart; web and WhatsApp say the same", async () => {
    const t = tenant();
    await link(t);
    const s = capture();
    await processOwnerInbound(msg("How much did we make today?"), s, { businessIds: t.ids });
    const web = await executeOwnerCommand({ graph: t.g, source: "web", actor: { kind: "web" }, key: "web:money-1", text: "How much did we make today?" });
    expect(s.sent[0].m.text).toBe(web.reply.text);
    expect(web.reply.text).toMatch(/Made \(verified by your payment provider\): nothing yet/);
  });
});

describe("bounded operations on a grounded cohort", () => {
  it("'recover today's abandoned carts' grounds exact targets, runs once through the executor, and a replay or re-run never contacts anyone twice", async () => {
    const customers = liveCustomers();
    setOperationSendersForTests(() => customers);
    const t = tenant();
    // A pilot business: SUPERVISED — the owner asking is the approval for the outreach.
    await applyControlChange(t.g.business.id, { mode: "supervised" }, { by: "founder", reason: "pilot" });
    const c1 = await cart(t);
    const c2 = await cart(t);
    await link(t);
    const s = capture();
    const first = msg("Recover today's abandoned carts");
    const r = await processOwnerInbound(first, s, { businessIds: t.ids });
    expect(r.status).toBe("processed");
    const [op] = await listOperations(t.g.business.id);
    expect(op.targets.map((x) => x.conversationId).sort()).toEqual([c1, c2].sort());
    expect(op.targets.every((x) => x.eligibility === "eligible" && /not due yet/.test(x.reason ?? ""))).toBe(true);
    expect(op.state).toBe("waiting_on_customers");
    expect(s.sent[0].m.text).toMatch(/Found 2 abandoned checkouts from today/);
    expect(s.sent[0].m.text).toMatch(/Contacted: 2/);
    expect(customers.sent).toHaveLength(2);
    const attempts = (await listAttempts(t.g.business.id)).length;
    expect(attempts).toBe(2);
    // The exact same WhatsApp message delivered again → duplicate, nothing re-runs.
    expect((await processOwnerInbound(first, capture(), { businessIds: t.ids })).status).toBe("duplicate");
    // A new command: everyone was contacted already → excluded with the reason; no second attempt.
    await processOwnerInbound(msg("Recover today's abandoned carts"), capture(), { businessIds: t.ids });
    const [latest] = await listOperations(t.g.business.id);
    expect(latest.targets.every((x) => x.eligibility === "excluded" && /limit|recently/.test(x.reason ?? ""))).toBe(true);
    expect((await listAttempts(t.g.business.id)).length).toBe(attempts);
    // A reminder is not an outcome: nothing is counted as a "case" or a result just because BARRY followed up.
    const ws = await getOwnerWorkspace(t.g);
    expect(ws.outcomes.filter((o) => o.kind === "case_created")).toEqual([]);
    expect(ws.today.completedOutcomes).toBe(0);
    // The conversation got exactly one reminder each.
    for (const id of [c1, c2]) expect((await getConversationStore().get(id))!.messages.filter((m) => m.role === "barry" && /left items in your cart/.test(m.content))).toHaveLength(1);
  });

  it("the plan and founder controls apply equally: nothing runs when follow-ups aren't in the plan or outreach is paused", async () => {
    const t = tenant();
    await cart(t);
    await selectPlan(t.g.business.id, { plan: "CORE" }, { by: "founder-test", reason: "core" });
    const r = await executeOwnerCommand({ graph: t.g, source: "whatsapp", actor: { kind: "whatsapp", identityId: "whatsapp:1", masked: "···0001" }, key: "wa:plan-1", text: "Recover today's abandoned carts" });
    expect(r.reply.text).toMatch(/aren't part of your current plan/);
    expect(r.reply.text).not.toMatch(/CORE|OPERATOR|entitlement|feature/);
    expect((await listOperations(t.g.business.id))[0].state).toBe("blocked");
    expect(await listAttempts(t.g.business.id)).toEqual([]);

    const u = tenant();
    await cart(u);
    await applyControlChange(u.g.business.id, { pauseConsequentialWrites: true }, { by: "founder", reason: "test" });
    const p = await executeOwnerCommand({ graph: u.g, source: "web", actor: { kind: "web" }, key: "web:pause-1", text: "Recover today's abandoned carts" });
    expect(p.reply.text).toMatch(/paused/);
    expect(await listAttempts(u.g.business.id)).toEqual([]);
  });

  it("stop: no new work for that cohort (the scheduled executor skips it too); sent messages are said to stay sent", async () => {
    setOperationSendersForTests(() => liveCustomers());
    const t = tenant();
    // A pilot business: SUPERVISED — the owner asking is the approval for the outreach.
    await applyControlChange(t.g.business.id, { mode: "supervised" }, { by: "founder", reason: "pilot" });
    await cart(t);
    await link(t);
    await processOwnerInbound(msg("Recover today's abandoned carts"), capture(), { businessIds: t.ids });
    const s = capture();
    await processOwnerInbound(msg("Stop the cart recovery"), s, { businessIds: t.ids });
    expect(s.sent[0].m.text).toMatch(/Stopped recovering abandoned checkouts\. 1 customer already contacted — those messages stay sent/);
    const [op] = await listOperations(t.g.business.id);
    expect(op).toMatchObject({ state: "stopped" });
    expect(op.stoppedBy).toMatch(/WhatsApp ···2233/);
    const held = await ownerHeldKeys(t.g.business.id);
    expect(held.has(op.targets[0].key)).toBe(true);
    // A stop with nothing running says so instead of pretending.
    const again = capture();
    await processOwnerInbound(msg("Stop."), again, { businessIds: t.ids });
    expect(again.sent[0].m.text).toMatch(/Nothing you started is running/);
    // A forged stop/start action fails.
    const forged = capture();
    await processOwnerInbound(tap(`o:${op.id}:AAAAAAAAAAAA:start`), forged, { businessIds: t.ids });
    expect(forged.sent[0].m.text).toMatch(/doesn't match/);
    expect(parseAction("o:op_123:short:start")).toBeUndefined();
    // The scheduled executor also respects the hold.
    const run = await runObligationExecutor(t.g, { now: new Date(Date.now() + 5 * 24 * 3600_000) });
    expect(run.results.filter((x) => x.key === op.targets[0].key).every((x) => x.outcome === "skipped")).toBe(true);
  });
});

describe("approvals from WhatsApp: the same durable request, exactly once", () => {
  it("a new request is announced once; Approve resolves the exact revision once; replays and double taps don't re-run", async () => {
    const t = tenant();
    const conversationId = await discountRequest(t);
    await link(t);
    const s = capture();
    const sentNotices = await notifyOwnerDecisions(t.g, { sender: s });
    expect(sentNotices).toHaveLength(1);
    expect(await notifyOwnerDecisions(t.g, { sender: s })).toHaveLength(0); // deduped
    const prompt = s.sent[0].m;
    expect(prompt.text).toMatch(/Needs your approval/);
    expect(prompt.text).toMatch(/10%/);
    const approve = prompt.actions!.find((a) => a.title === "Approve")!;
    const [approval] = (await getBackend().listApprovals(t.g.business.id)).filter((a) => a.conversationId === conversationId);
    const before = (await getConversationStore().get(conversationId))!.messages.length;
    const tapMsg = tap(approve.id);
    const r = await processOwnerInbound(tapMsg, s, { businessIds: t.ids });
    expect(r.status).toBe("processed");
    expect((await getBackend().getApproval(approval.id))?.status).toBe("approved");
    const after = (await getConversationStore().get(conversationId))!.messages.length;
    expect(after).toBe(before + 1);
    // Same provider message again → duplicate; a new tap of the same button → "already done"; nothing re-runs.
    expect((await processOwnerInbound(tapMsg, capture(), { businessIds: t.ids })).status).toBe("duplicate");
    const twice = capture();
    await processOwnerInbound(tap(approve.id), twice, { businessIds: t.ids });
    expect(twice.sent[0].m.text).toMatch(/Already done/);
    expect((await getConversationStore().get(conversationId))!.messages.length).toBe(after);
  });

  it("forged, foreign or stale decisions fail closed", async () => {
    const t = tenant();
    const conversationId = await discountRequest(t);
    await link(t);
    const s = capture();
    await notifyOwnerDecisions(t.g, { sender: s });
    const approve = s.sent[0].m.actions!.find((a) => a.title === "Approve")!;
    // Forged prompt key.
    const forged = capture();
    await processOwnerInbound(tap("d:pr_0123456789abcdef:approve"), forged, { businessIds: t.ids });
    expect(forged.sent[0].m.text).toMatch(/doesn't match a request I sent you/);
    // Another linked owner number can't use a prompt sent to this one.
    await link(t, OTHER);
    const other = capture();
    await processOwnerInbound(tap(approve.id, OTHER), other, { businessIds: t.ids });
    expect(other.sent[0].m.text).toMatch(/doesn't match a request I sent you/);
    // Decided on the web meanwhile → the WhatsApp tap is stale.
    const [approval] = (await getBackend().listApprovals(t.g.business.id)).filter((a) => a.conversationId === conversationId);
    const { resumeAfterApproval } = await import("@/lib/runtime");
    await resumeAfterApproval(t.g, approval.id, "declined", "owner (web)");
    const stale = capture();
    await processOwnerInbound(tap(approve.id), stale, { businessIds: t.ids });
    expect(stale.sent[0].m.text).toMatch(/changed or was already decided/);
    expect((await getBackend().getApproval(approval.id))?.status).toBe("declined");
  });

  it("outside WhatsApp's 24-hour window BARRY records the blocker instead of sending", async () => {
    const t = tenant();
    await discountRequest(t);
    await link(t);
    const s = capture();
    const out = await notifyOwnerDecisions(t.g, { sender: s, now: new Date(Date.now() + 25 * 3600_000) });
    expect(out[0]).toMatchObject({ status: "blocked" });
    expect(out[0].reason).toMatch(/24-hour window/);
    expect(s.sent).toHaveLength(0);
    expect((await listBriefs(t.g.business.id))[0].status).toBe("blocked");
  });
});

describe("rules, audit, links and the founder boundary", () => {
  it("a rule from WhatsApp is only prepared — nothing changes until it's reviewed in Train BARRY", async () => {
    const t = tenant();
    const before = JSON.stringify(await getOwnerWorkspace(t.g).then((w) => w.capabilities));
    const r = await executeOwnerCommand({ graph: t.g, source: "whatsapp", actor: { kind: "whatsapp", identityId: "whatsapp:1", masked: "···0001" }, key: "wa:rule-1", text: "Don't offer more than 5% today." });
    expect(r.reply.text).toMatch(/nothing has changed yet/);
    expect(await getBackend().listOperatorRecords(t.g.business.id, "learning_change")).toEqual([]);
    expect(JSON.stringify(await getOwnerWorkspace(t.g).then((w) => w.capabilities))).toBe(before);
  });

  it("every command leaves a structured trace; replies never carry founder or economics data; links carry no authority", async () => {
    const t = tenant();
    await cart(t);
    await link(t);
    process.env.BARRY_PUBLIC_URL = "https://preview.example";
    const s = capture();
    for (const text of ["Who needs me?", "What are you working on?", "How much did we make today?", "Recover today's abandoned carts", "What happened with the recovery I started?"]) await processOwnerInbound(msg(text), s, { businessIds: t.ids });
    for (const { m } of s.sent) {
      expect(JSON.stringify(m)).not.toMatch(/cost|margin|contribution|token|founder|model usage|rate card|OPENAI|BARRY_/i);
      for (const l of m.links ?? []) expect(l.href).toMatch(/^https:\/\/preview\.example\/owner/);
    }
    const op = (await listCommandRecords(t.g.business.id)).find((c) => c.intent?.kind === "operation_request")!;
    expect(op.trace.map((x) => x.step)).toEqual(expect.arrayContaining(["identity", "business", "interpretation", "state", "grounding", "entitlement", "authority", "plan", "execution", "verification", "reply", "delivery"]));
    expect(JSON.stringify(op.trace)).not.toContain(PHONE);
    expect(ownerLink("/owner?tab=actions", "web")).toBe("/owner?tab=actions");
  });
});
