import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage, readInboundTurns, resumeAfterApproval } from "@/lib/runtime";
import { setReasonerForTests, type ReasonerContext } from "@/lib/reasoner";
import { getConversationStore, ConversationConflictError } from "@/lib/state";
import { MemoryLockStore, setLockStoreForTests, LOCK_TTL_MS } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { processInbound, readDeliveries, type OutboundSender } from "@/lib/channels/gateway";
import { readLedger } from "@/lib/runtime/ledger";
import { createHandoff, readHandoffs } from "@/lib/runtime/handoff";
import { resetControlsCacheForTests } from "@/lib/hq/controls";
import { setBusinessGraphResolverForTests } from "@/lib/business-graph-repository";
import { getBusinessGraph } from "@/lib/fixtures";
import { getBackend } from "@/lib/store";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * PAID-PILOT P0 PHASE 3 — CONVERSATION RELIABILITY UNDER CONCURRENT INBOUND MESSAGES.
 *
 * Deterministic: no sleeps. A gated model holds a turn exactly between "state was read" and "state is
 * saved" until the test releases it, so every interleaving below is forced, not hoped for. The stores
 * behave like production (every read is an independent copy; saves are version-checked; the lock and
 * the inbox are the same contracts as their database twins).
 */

class GatedModel extends ScriptedModel {
  private gates = new Map<string, { entered: () => void; enteredP: Promise<void>; release: (fail?: boolean) => void; releaseP: Promise<boolean> }>();
  seen: string[] = [];
  constructor() {
    super(() => undefined);
  }
  /** The next turn for this exact customer message stops inside the model until released. */
  gate(message: string) {
    let entered!: () => void;
    let release!: (fail?: boolean) => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    const releaseP = new Promise<boolean>((r) => (release = (fail = false) => r(fail)));
    this.gates.set(message, { entered, enteredP, release, releaseP });
    return { entered: enteredP, release: () => release(false), fail: () => release(true) };
  }
  override async understandDetailed(ctx: ReasonerContext) {
    const msg = ctx.customerMessage ?? "";
    this.seen.push(msg);
    const g = this.gates.get(msg);
    if (g) {
      this.gates.delete(msg);
      g.entered();
      if (await g.releaseP) throw new Error("model call timed out");
    }
    return super.understandDetailed(ctx);
  }
}

const capture = (mode: "live" | "dry_run" = "live"): OutboundSender & { sent: { to: string; text: string }[]; onSend?: () => void } => {
  const sent: { to: string; text: string }[] = [];
  const s: OutboundSender & { sent: typeof sent; onSend?: () => void } = { channel: "whatsapp", mode, sent, send: async (to, text) => (sent.push({ to, text }), s.onSend?.(), { providerMessageId: `wamid.out.${sent.length}` }) };
  return s;
};

let dispose: (() => void) | undefined;
let locks: MemoryLockStore;
let inbox: MemoryInboxStore;
beforeEach(() => {
  resetControlsCacheForTests();
  locks = new MemoryLockStore();
  inbox = new MemoryInboxStore();
  setLockStoreForTests(locks);
  setInboxStoreForTests(inbox);
});
afterEach(() => {
  setReasonerForTests(undefined);
  setBusinessGraphResolverForTests(undefined);
  setLockStoreForTests(undefined);
  setInboxStoreForTests(undefined);
  resetControlsCacheForTests();
  vi.restoreAllMocks();
  dispose?.();
  dispose = undefined;
});

function tenant() {
  const r = isolatedRetailer();
  dispose = r.dispose;
  setBusinessGraphResolverForTests((id) => (id === r.g.business.id ? r.g : getBusinessGraph(id)));
  const model = new GatedModel();
  setReasonerForTests(model);
  const phone = `9725${Math.floor(Math.random() * 1e8)}`;
  const id = `wa:${r.g.business.id}:${phone}`;
  let n = 0;
  const msg = (text: string, inboundId = `wamid.in.${phone}.${++n}`) => ({ businessId: r.g.business.id, conversationId: id, customerId: `wa:${phone}`, identity: { channel: "whatsapp" as const, channelUserId: phone, verifiedIdentifier: `phone:${phone}` }, text, receivedAt: new Date().toISOString(), inboundId });
  return { ...r, model, id, phone, msg };
}

const customerTexts = async (id: string) => (await getConversationStore().get(id))!.messages.filter((m) => m.role === "customer").map((m) => m.content);
const tick = () => new Promise((r) => setImmediate(r));

describe("the old race, and the backstop that now stops it", () => {
  it("two copies read at the same version: the second save is refused — never a silent overwrite", async () => {
    const store = getConversationStore();
    const id = conv("cas");
    await store.getOrCreate(id, "b1", "c1").then((s) => store.save(s));
    const a = (await store.get(id))!;
    const b = (await store.get(id))!;
    a.knownFields.handoff = "kept";
    await store.save(a);
    b.knownFields.other = "would erase the handoff";
    await expect(store.save(b)).rejects.toBeInstanceOf(ConversationConflictError);
    const now = (await store.get(id))!;
    expect(now.knownFields.handoff).toBe("kept");
    expect(now.knownFields.other).toBeUndefined();
  });
});

describe("3 WhatsApp messages arriving nearly simultaneously", () => {
  it("are processed one at a time, in order, each on the latest state — nothing overwritten, 3 replies sent once each", async () => {
    const t = tenant();
    const sender = capture();
    const gate = t.model.gate("hi");
    const r1 = processInbound(t.msg("hi"), sender);
    await gate.entered; // turn 1 has read the state and is inside the model
    const r2 = processInbound(t.msg("I want the midnight dress"), sender);
    const r3 = processInbound(t.msg("size M please"), sender);
    await tick();
    // While turn 1 is running nobody else touches the conversation.
    expect(t.model.seen).toEqual(["hi"]);
    gate.release();
    const results = await Promise.all([r1, r2, r3]);
    expect(results.map((r) => r.status)).toEqual(["processed", "processed", "processed"]);
    expect(t.model.seen).toEqual(["hi", "I want the midnight dress", "size M please"]);
    expect(await customerTexts(t.id)).toEqual(["hi", "I want the midnight dress", "size M please"]);
    const state = (await getConversationStore().get(t.id))!;
    expect(state.turns).toHaveLength(3);
    expect(state.messages.filter((m) => m.role === "barry")).toHaveLength(3);
    // Every message's bookkeeping survived: one delivery per message (each tied to its reply), one turn stamp each.
    const deliveries = readDeliveries(state.knownFields);
    expect(deliveries.map((d) => d.status)).toEqual(["sent", "sent", "sent"]);
    expect(new Set(deliveries.map((d) => d.inboundId)).size).toBe(3);
    expect(deliveries.every((d) => state.messages.some((m) => m.role === "barry" && m.at === d.messageAt))).toBe(true);
    expect(Object.keys(readInboundTurns(state.knownFields))).toHaveLength(3);
    expect(sender.sent).toHaveLength(3);
    expect((await inbox.listByConversation(t.id)).map((r) => r.status)).toEqual(["sent", "sent", "sent"]);
  });
});

describe("duplicate webhook delivery", () => {
  it("the same provider message delivered twice — at once and again later — runs one turn and sends one reply", async () => {
    const t = tenant();
    const sender = capture();
    const m = t.msg("hello", "wamid.dup.1");
    const gate = t.model.gate("hello");
    const a = processInbound(m, sender);
    await gate.entered;
    const b = processInbound(m, sender);
    gate.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.status, rb.status].sort()).toEqual(["duplicate", "processed"]);
    expect((await processInbound(m, sender)).status).toBe("duplicate");
    expect(t.model.seen).toEqual(["hello"]);
    expect(await customerTexts(t.id)).toEqual(["hello"]);
    expect(sender.sent).toHaveLength(1);
  });
});

describe("two different customers at once", () => {
  it("never wait on each other: B is answered while A's turn is still running", async () => {
    const a = tenant();
    const phoneB = `9725${Math.floor(Math.random() * 1e8)}`;
    const idB = `wa:${a.g.business.id}:${phoneB}`;
    const msgB = { ...a.msg("hi from B", `wamid.b.1`), conversationId: idB, customerId: `wa:${phoneB}`, identity: { channel: "whatsapp" as const, channelUserId: phoneB, verifiedIdentifier: `phone:${phoneB}` } };
    const sender = capture();
    const gate = a.model.gate("hi from A");
    const ra = processInbound(a.msg("hi from A"), sender);
    await gate.entered;
    const rb = await processInbound(msgB, sender);
    expect(rb.status).toBe("processed");
    expect(await customerTexts(idB)).toEqual(["hi from B"]);
    gate.release();
    expect((await ra).status).toBe("processed");
    expect(sender.sent.map((s) => s.to).sort()).toEqual([a.phone, phoneB].sort());
  });
});

describe("inbound message while an owner approval is pending", () => {
  it("the owner's decision and the customer's message are serialized: both recorded, the request decided exactly once", async () => {
    const t = tenant();
    const sender = capture();
    const SCRIPT: Record<string, object> = {
      "the midnight dress": { commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true },
      "add it in M": { commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true },
      "could you ask the owner to approve 10% off this dress?": { constraints: { discountPct: 10 }, advancesTransaction: true, asks: [{ ask: "10% off this dress", kind: "change", coveredByThisIR: true }] },
    };
    t.model.plan = (ctx) => SCRIPT[ctx.customerMessage ?? ""] as never;
    for (const text of Object.keys(SCRIPT)) expect((await processInbound(t.msg(text), sender)).status).toBe("processed");
    const [approval] = (await getBackend().listApprovals(t.g.business.id)).filter((a) => a.conversationId === t.id);
    expect(approval?.status).toBe("pending");

    const gate = t.model.gate("are you still there?");
    const customer = processInbound(t.msg("are you still there?"), sender);
    await gate.entered;
    const owner = resumeAfterApproval(t.g, approval.id, "approved", "owner");
    await tick();
    gate.release();
    await Promise.all([customer, owner]);
    expect((await getBackend().getApproval(approval.id))?.status).toBe("approved");
    const state = (await getConversationStore().get(t.id))!;
    expect(state.messages.filter((m) => m.role === "customer").map((m) => m.content)).toContain("are you still there?");
    // The approval's own ledger trail is intact next to the customer's turn.
    expect(readLedger(state).some((e) => e.reference === approval.id || e.status === "awaiting_owner")).toBe(true);
    // A second decision (a double tap) changes nothing.
    await resumeAfterApproval(t.g, approval.id, "approved", "owner");
    expect((await getBackend().listApprovals(t.g.business.id)).filter((a) => a.conversationId === t.id && a.status === "approved")).toHaveLength(1);
  });
});

describe("inbound burst during a handoff", () => {
  it("the open handoff survives three rapid messages (never overwritten by a stale copy)", async () => {
    const t = tenant();
    const sender = capture();
    expect((await processInbound(t.msg("hello"), sender)).status).toBe("processed");
    const store = getConversationStore();
    const state = (await store.get(t.id))!;
    createHandoff(t.g, state, { trigger: "customer_asked", reason: "wants a person", urgency: "normal", unresolved: [] });
    await store.save(state);
    // A person holds the conversation now (Phase 4): the burst is stored and held — no model call, no reply.
    const burst = await Promise.all(["one", "two", "three"].map((x) => processInbound(t.msg(x), sender)));
    expect(burst.map((r) => r.status)).toEqual(["held", "held", "held"]);
    const after = (await store.get(t.id))!;
    expect(readHandoffs(after).filter((h) => h.status === "open")).toHaveLength(1);
    expect(await customerTexts(t.id)).toEqual(["hello", "one", "two", "three"]);
  });
});

describe("failures mid-way: nothing duplicated, everything recoverable", () => {
  it("model timeout after the state was read: nothing saved, nothing sent, retryable — the retry answers once", async () => {
    const t = tenant();
    const sender = capture();
    const m = t.msg("are you open today?", "wamid.timeout.1");
    const gate = t.model.gate("are you open today?");
    const first = processInbound(m, sender);
    await gate.entered;
    gate.fail();
    const r1 = await first;
    expect(r1).toMatchObject({ status: "failed", retry: true });
    expect(sender.sent).toHaveLength(0);
    expect((await getConversationStore().get(t.id))?.messages.filter((x) => x.role === "customer") ?? []).toHaveLength(0);
    // Meta delivers the same message again: processed once, answered once.
    const r2 = await processInbound(m, sender);
    expect(r2.status).toBe("processed");
    expect(await customerTexts(t.id)).toEqual(["are you open today?"]);
    expect(sender.sent).toHaveLength(1);
  });

  it("the turn saved but recording 'reply ready' failed: the retry recovers the reply from the turn — no second turn, one send", async () => {
    const t = tenant();
    const sender = capture();
    const m = t.msg("price of the dress?", "wamid.partial.1");
    inbox.failNextUpdateTo = "reply_ready";
    await expect(processInbound(m, sender)).rejects.toThrow(/simulated/);
    expect(sender.sent).toHaveLength(0);
    const r = await processInbound(m, sender);
    expect(r.status).toBe("processed");
    expect(t.model.seen).toEqual(["price of the dress?"]);
    expect((await getConversationStore().get(t.id))!.turns).toHaveLength(1);
    expect(sender.sent).toHaveLength(1);
  });

  it("the send succeeded but persisting its result failed: the retry finishes the bookkeeping — never sends again", async () => {
    const t = tenant();
    const sender = capture();
    const m = t.msg("do you ship to Haifa?", "wamid.sent-unsaved.1");
    inbox.failNextUpdateTo = "sent";
    await processInbound(m, sender);
    expect(sender.sent).toHaveLength(1);
    expect((await inbox.listByConversation(t.id))[0].status).toBe("sending");
    const r = await processInbound(m, sender);
    expect(["processed", "duplicate"]).toContain(r.status);
    expect(sender.sent).toHaveLength(1);
    expect((await inbox.listByConversation(t.id))[0].status).toBe("sent");
  });

  it("the send happened and NOTHING about it was persisted: the outcome is unknown — said so, never re-sent", async () => {
    const t = tenant();
    const sender = capture();
    const m = t.msg("can I pay later?", "wamid.unknown.1");
    // The provider accepts the message, then every write after it fails (e.g. the database blips).
    const store = getConversationStore();
    const realSave = store.save.bind(store);
    sender.onSend = () => {
      vi.spyOn(store, "save").mockImplementationOnce(async () => {
        throw new Error("database unavailable");
      });
    };
    await expect(processInbound(m, sender)).resolves.toBeDefined();
    expect(sender.sent).toHaveLength(1);
    expect((await inbox.listByConversation(t.id))[0].status).toBe("sending");
    vi.spyOn(store, "save").mockImplementation(realSave);
    sender.onSend = undefined;
    await processInbound(m, sender);
    expect(sender.sent).toHaveLength(1);
    expect((await inbox.listByConversation(t.id))[0].status).toBe("delivery_unknown");
    const d = readDeliveries((await store.get(t.id))!.knownFields).at(-1)!;
    expect(d).toMatchObject({ status: "failed" });
    expect(d.error).toMatch(/delivery unknown/);
  });

  it("a holder that stalls past its lease: the next request takes over; the stalled turn's late save is refused — no overwrite, one reply", async () => {
    const t = tenant();
    const sender = capture();
    let clock = Date.now();
    locks.now = () => clock;
    const gate = t.model.gate("first");
    const stalled = processInbound(t.msg("first"), sender);
    await gate.entered;
    clock += LOCK_TTL_MS + 1; // the stalled holder's lease lapses
    const takeover = await processInbound(t.msg("second"), sender);
    expect(takeover.status).toBe("processed");
    gate.release(); // the stalled turn wakes up with a stale copy
    const late = await stalled;
    expect(late.status).not.toBe("queued");
    const state = (await getConversationStore().get(t.id))!;
    // Both messages answered exactly once, in the state that won; the stale save wrote nothing.
    expect(state.messages.filter((m) => m.role === "customer").map((m) => m.content)).toEqual(["first", "second"]);
    expect(state.turns).toHaveLength(2);
    expect(sender.sent).toHaveLength(2);
    expect((await inbox.listByConversation(t.id)).map((r) => r.status)).toEqual(["sent", "sent"]);
  });
});

describe("web and WhatsApp continuity", () => {
  it("a web turn and a WhatsApp turn on the same conversation are serialized by the same lock", async () => {
    const t = tenant();
    const sender = capture();
    const gate = t.model.gate("from whatsapp");
    const wa = processInbound(t.msg("from whatsapp"), sender);
    await gate.entered;
    const web = handleCustomerMessage(t.g, t.id, `wa:${t.phone}`, "from the web chat");
    await tick();
    expect(t.model.seen).toEqual(["from whatsapp"]);
    gate.release();
    await Promise.all([wa, web]);
    expect(await customerTexts(t.id)).toEqual(["from whatsapp", "from the web chat"]);
    expect((await getConversationStore().get(t.id))!.turns).toHaveLength(2);
  });
});
