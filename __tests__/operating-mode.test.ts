import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { setReasonerForTests } from "@/lib/reasoner";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { processInbound, type OutboundSender } from "@/lib/channels/gateway";
import { DEFAULT_CONTROLS, applyControlChange, applyFounderControls, listControlAudit, loadControls, resetControlsCacheForTests } from "@/lib/hq/controls";
import { operatingMode, proactiveGate, replyGate } from "@/lib/runtime/operating-mode";
import { SUPERVISED_AUTONOMOUS } from "@/lib/runtime/action-risk";
import { OwnerModeError, ownerMode, ownerPause, ownerResume } from "@/lib/owner/mode";
import { interpretCommand } from "@/lib/owner/command";
import { executeOwnerCommand } from "@/lib/owner/command-service";
import { runObligationExecutor } from "@/lib/operator/executor";
import { setBusinessGraphResolverForTests } from "@/lib/business-graph-repository";
import { getBusinessGraph } from "@/lib/fixtures";
import type { BusinessGraph } from "@/lib/business-graph";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * PAID-PILOT P0 PHASE 6 — PER-BUSINESS OPERATING MODE as a runtime control: PAUSED / SIMULATOR /
 * SUPERVISED / LIVE, stored per business, read through one gate, audited, changeable by the owner (pause)
 * and the founder, respected by the customer runtime, scheduled work and owner commands, failing safe.
 */

const disposers: (() => void)[] = [];
const graphs = new Map<string, BusinessGraph>();
beforeEach(() => {
  resetControlsCacheForTests();
  setLockStoreForTests(new MemoryLockStore());
  setInboxStoreForTests(new MemoryInboxStore());
});
afterEach(() => {
  setReasonerForTests(undefined);
  setBusinessGraphResolverForTests(undefined);
  setLockStoreForTests(undefined);
  setInboxStoreForTests(undefined);
  resetControlsCacheForTests();
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
  graphs.clear();
});

function business() {
  const r = isolatedRetailer();
  disposers.push(r.dispose);
  graphs.set(r.g.business.id, r.g);
  setBusinessGraphResolverForTests((id) => graphs.get(id) ?? getBusinessGraph(id));
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  return { ...r, model };
}

async function inCart(model: ScriptedModel, g: BusinessGraph, id: string) {
  model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
  await handleCustomerMessage(g, id, "c", "the midnight dress");
  model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true });
  return handleCustomerMessage(g, id, "c", "add it in M");
}
const checkoutPlan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, customerInfo: { name: "Adi", phone: "0505550114" }, evidence: { "customerInfo.name": "Adi", "customerInfo.phone": "0505550114" } }) as never;

const capture = () => {
  const sent: string[] = [];
  const s: OutboundSender & { sent: string[] } = { channel: "whatsapp", mode: "live", sent, send: async (_to, text) => (sent.push(text), { providerMessageId: `o${sent.length}` }) };
  return s;
};
const waMsg = (g: BusinessGraph, phone: string, text: string, n: number) => ({ businessId: g.business.id, conversationId: `wa:${g.business.id}:${phone}`, customerId: `wa:${phone}`, identity: { channel: "whatsapp" as const, channelUserId: phone }, text, receivedAt: new Date().toISOString(), inboundId: `wamid.mode.${phone}.${n}` });

describe("the one gate", () => {
  it("reads the mode from the stored controls; PAUSED wins; every lever only tightens", () => {
    expect(operatingMode(DEFAULT_CONTROLS)).toBe("simulator");
    expect(operatingMode({ ...DEFAULT_CONTROLS, mode: "live", pausedBusiness: true })).toBe("paused");
    expect(proactiveGate({ ...DEFAULT_CONTROLS })).toEqual({ allowed: true, live: false, mode: "simulator" });
    expect(proactiveGate({ ...DEFAULT_CONTROLS, mode: "supervised" })).toMatchObject({ allowed: false, needsApproval: true });
    expect(proactiveGate({ ...DEFAULT_CONTROLS, mode: "supervised" }, { ownerInitiated: true })).toMatchObject({ allowed: true, live: true });
    expect(proactiveGate({ ...DEFAULT_CONTROLS, mode: "live" })).toMatchObject({ allowed: true, live: true });
    expect(proactiveGate({ ...DEFAULT_CONTROLS, mode: "live", safeMode: true })).toMatchObject({ allowed: false });
    expect(proactiveGate({ ...DEFAULT_CONTROLS, mode: "live", pausedBusiness: true }, { ownerInitiated: true })).toMatchObject({ allowed: false, mode: "paused" });
    expect(replyGate({ ...DEFAULT_CONTROLS, pausedBusiness: true }, "whatsapp")).toMatchObject({ allowed: false });
    expect(replyGate({ ...DEFAULT_CONTROLS, mode: "live" }, "whatsapp")).toEqual({ allowed: true });
  });
});

describe("SUPERVISED: what runs on its own vs. what needs the owner", () => {
  it("only reversible, low-risk work is autonomous; money, commitments and unknown capabilities need approval", () => {
    const sup = { ...DEFAULT_CONTROLS, mode: "supervised" as const };
    const allowed = { status: "allowed" as const };
    const verdict = (action: string, params: Record<string, unknown> = {}) => applyFounderControls(sup, action, params, allowed).status;
    expect(verdict("addToCart", { productId: "p1", quantity: 1 })).toBe("allowed");
    expect(verdict("updateCartLine", { lineId: "l1", quantity: 2 })).toBe("allowed");
    expect(verdict("invokeCapability", { capability: "support.ticket.create", input: { subject: "late parcel" } })).toBe("allowed");
    for (const a of ["createCommerceCheckout", "createPaymentRequest", "createCommerceOrder", "createBooking"]) expect(verdict(a)).toBe("requires_approval");
    for (const c of ["payments.refund", "shipping.shipment.create", "messaging.send", "some.future.capability"]) expect(verdict("invokeCapability", { capability: c, input: {} })).toBe("requires_approval");
    // A price / discount in the request is a policy exception — never "low-risk".
    expect(verdict("updateCartLine", { lineId: "l1", quantity: 1, discountPct: 10 })).toBe("requires_approval");
    // Reads are never gated; the business's own denials are never loosened.
    expect(verdict("searchProducts")).toBe("allowed");
    expect(applyFounderControls(sup, "createBooking", {}, { status: "requires_approval" }).status).toBe("allowed"); // (no extra tightening: the base already asks)
    expect(SUPERVISED_AUTONOMOUS).toEqual({ actions: ["addToCart", "updateCartLine"], capabilities: ["commerce.cart.create", "commerce.cart.update", "support.ticket.create"] });
  });
});

describe("SUPERVISED vs LIVE in the customer runtime", () => {
  it("SUPERVISED: reversible cart work runs on its own; the checkout (money) waits for the owner; LIVE: the business's own rules decide", async () => {
    const a = business();
    await applyControlChange(a.g.business.id, { mode: "supervised" }, { by: "founder", reason: "pilot" });
    const ida = conv("sup");
    const cart = await inCart(a.model, a.g, ida);
    expect(cart.response.length).toBeGreaterThan(0);
    expect(cart.turn.trace?.steps[0]).toMatchObject({ action: "addToCart", policy: { status: "allowed" } });
    a.model.plan = checkoutPlan;
    const pay = await handleCustomerMessage(a.g, ida, "c", "checkout, Adi 0505550114");
    expect(pay.turn.trace?.steps[0]).toMatchObject({ action: "createCommerceCheckout", policy: { status: "requires_approval", policyId: "operating_mode:supervised" } });
    expect(pay.state.knownFields.__paymentRequestId).toBeUndefined();

    const b = business();
    await applyControlChange(b.g.business.id, { mode: "live" }, { by: "founder", reason: "live" });
    const idb = conv("live");
    await inCart(b.model, b.g, idb);
    b.model.plan = checkoutPlan;
    const out = await handleCustomerMessage(b.g, idb, "c", "checkout, Adi 0505550114");
    expect(out.turn.trace?.steps[0]).toMatchObject({ action: "createCommerceCheckout", policy: { status: "allowed" } });
  });
});

describe("PAUSED", () => {
  it("the owner pauses: customer messages are kept, nothing is answered, run or sent; nothing proactive; resume restores", async () => {
    const t = business();
    await applyControlChange(t.g.business.id, { mode: "live" }, { by: "founder", reason: "live" });
    const view = await ownerPause(t.g, "the owner (web)");
    expect(view).toMatchObject({ mode: "paused", pausedBy: "owner" });
    const out = capture();
    const r = await processInbound(waMsg(t.g, "972500000001", "hi, are you open?", 1), out);
    expect(r.status).toBe("held");
    expect(out.sent).toHaveLength(0);
    const state = await getConversationStore().get(`wa:${t.g.business.id}:972500000001`);
    expect(state?.messages.map((m) => m.role)).toEqual(["customer"]);
    expect(state?.turns).toHaveLength(0);
    const run = await runObligationExecutor(t.g, { senders: () => out });
    expect(run.blocked).toMatch(/paused/);

    expect(await ownerResume(t.g, "the owner (web)")).toMatchObject({ mode: "live", pausedBy: null });
    expect((await processInbound(waMsg(t.g, "972500000001", "hello again", 2), out)).status).toBe("processed");
    expect(out.sent).toHaveLength(1);
  });

  it("a founder's pause can't be lifted by the owner (nothing changes); the founder lifts it", async () => {
    const t = business();
    await applyControlChange(t.g.business.id, { pausedBusiness: true }, { by: "founder", reason: "incident" });
    expect(await ownerMode(t.g)).toMatchObject({ mode: "paused", pausedBy: "founder" });
    await expect(ownerResume(t.g, "the owner (web)")).rejects.toBeInstanceOf(OwnerModeError);
    expect((await loadControls(t.g.business.id)).pausedBusiness).toBe(true);
    // The owner pausing again doesn't take over the founder's pause.
    await ownerPause(t.g, "the owner (web)");
    expect((await ownerMode(t.g)).pausedBy).toBe("founder");
    await applyControlChange(t.g.business.id, { pausedBusiness: false }, { by: "founder", reason: "resolved" });
    expect((await ownerMode(t.g)).mode).toBe("simulator");
  });

  it("pausing one business never affects another", async () => {
    const a = business();
    const b = business();
    await ownerPause(a.g, "the owner (web)");
    const out = capture();
    expect((await processInbound(waMsg(a.g, "972500000002", "hi", 1), out)).status).toBe("held");
    expect((await processInbound(waMsg(b.g, "972500000003", "hi", 1), out)).status).toBe("processed");
  });

  it("every mode change is audited (who, when, before → after)", async () => {
    const t = business();
    await ownerPause(t.g, "the owner (web)");
    await ownerResume(t.g, "the owner (web)");
    const log = await listControlAudit(t.g.business.id);
    expect(log).toHaveLength(2);
    expect(log.every((e) => e.by === "the owner (web)" && Boolean(e.at))).toBe(true);
    expect(log.map((e) => [e.before.pausedBusiness, e.after.pausedBusiness]).sort()).toEqual([[false, true], [true, false]]);
  });
});

describe("owner commands — one service on every surface", () => {
  it("“pause BARRY” / “resume BARRY” are mode changes (not a workflow stop), and act the same from web and WhatsApp", async () => {
    expect(interpretCommand("pause BARRY").intent).toEqual({ kind: "mode_change", to: "paused" });
    expect(interpretCommand("Please stop yourself").intent).toEqual({ kind: "mode_change", to: "paused" });
    expect(interpretCommand("resume").intent).toEqual({ kind: "mode_change", to: "resumed" });
    expect(interpretCommand("stop the recovery").intent.kind).toBe("operation_stop");
    expect(interpretCommand("is BARRY paused?").intent.kind).toBe("query");
    const t = business();
    const web = await executeOwnerCommand({ graph: t.g, source: "web", actor: { kind: "web" }, key: "web:pause-1", text: "pause BARRY" });
    expect(web.reply.text).toMatch(/^Paused\./);
    expect((await ownerMode(t.g)).mode).toBe("paused");
    const wa = await executeOwnerCommand({ graph: t.g, source: "whatsapp", actor: { kind: "whatsapp", identityId: "oid", masked: "•••01" }, key: "wa:resume-1", text: "resume BARRY" });
    expect(wa.reply.text).toMatch(/^Resumed\./);
    expect((await ownerMode(t.g)).mode).toBe("simulator");
  });
});

describe("transitions fail safe", () => {
  it("controls that can't be read (and were never seen) read as safe mode: nothing proactive, every consequential action waits", async () => {
    const t = business();
    vi.spyOn(getBackend(), "listOperatorRecords").mockRejectedValueOnce(new Error("db down"));
    const c = await loadControls(t.g.business.id);
    expect(c.safeMode).toBe(true);
    expect(proactiveGate(c)).toMatchObject({ allowed: false });
  });

  it("concurrent changes are serialized — neither is lost", async () => {
    const t = business();
    await Promise.all([applyControlChange(t.g.business.id, { mode: "live" }, { by: "founder", reason: "a" }), ownerPause(t.g, "the owner (web)")]);
    const c = await loadControls(t.g.business.id);
    expect(c).toMatchObject({ mode: "live", pausedBusiness: true });
    expect(await listControlAudit(t.g.business.id)).toHaveLength(2);
  });
});
