import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/fabric";
import { HumanHoldsConversationError, readInboundTurns, resumeAfterApproval } from "@/lib/runtime";
import { setReasonerForTests, type ReasonerContext } from "@/lib/reasoner";
import { getConversationStore } from "@/lib/state";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { processInbound, readDeliveries, type OutboundSender } from "@/lib/channels/gateway";
import { createHandoff, readHandoffs, resolveHandoff } from "@/lib/runtime/handoff";
import { humanHolds, readControl, readControlLog, readOwnerReplies, writeOwnerReply } from "@/lib/runtime/control";
import { OwnerControlError, ownerReply, ownerReturnToBarry, ownerTakeOver, setOwnerReplySenderForTests } from "@/lib/owner/human-control";
import { getOwnerConversation } from "@/lib/owner/conversation";
import { truthfulTranscript } from "@/lib/operator/execution-state";
import { updateConversation } from "@/lib/state/update";
import { resetControlsCacheForTests } from "@/lib/hq/controls";
import { setBusinessGraphResolverForTests } from "@/lib/business-graph-repository";
import { getBusinessGraph } from "@/lib/fixtures";
import { getBackend } from "@/lib/store";
import { ScriptedModel, isolatedRetailer } from "./support/scripted-model";

/**
 * PAID-PILOT P0 PHASE 4 — REAL HANDOFF. The invariant under test:
 *
 *   When a person holds a conversation, BARRY does not reply to the customer on its own.
 *
 * Deterministic (no sleeps): a gated model stops a BARRY turn between "state read" and "state saved" so the
 * races below are forced. Stores behave like production (independent copies, version-checked saves, the
 * same lock and inbox contracts as the database).
 */

class GatedModel extends ScriptedModel {
  private gates = new Map<string, { entered: () => void; enteredP: Promise<void>; releaseP: Promise<boolean> }>();
  seen: string[] = [];
  constructor() {
    super(() => undefined);
  }
  gate(message: string) {
    let entered!: () => void;
    let release!: (fail?: boolean) => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    const releaseP = new Promise<boolean>((r) => (release = (fail = false) => r(fail)));
    this.gates.set(message, { entered, enteredP, releaseP });
    return { entered: enteredP, release: () => release(false) };
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

type Capture = OutboundSender & { sent: { to: string; text: string }[]; fail?: boolean };
const capture = (): Capture => {
  const sent: { to: string; text: string }[] = [];
  const s: Capture = {
    channel: "whatsapp",
    mode: "live",
    sent,
    send: async (to, text) => {
      if (s.fail) throw new Error("provider rejected the message");
      sent.push({ to, text });
      return { providerMessageId: `wamid.out.${sent.length}` };
    },
  };
  return s;
};

let dispose: (() => void) | undefined;
let inbox: MemoryInboxStore;
beforeEach(() => {
  resetControlsCacheForTests();
  setLockStoreForTests(new MemoryLockStore());
  inbox = new MemoryInboxStore();
  setInboxStoreForTests(inbox);
});
afterEach(() => {
  setReasonerForTests(undefined);
  setBusinessGraphResolverForTests(undefined);
  setLockStoreForTests(undefined);
  setInboxStoreForTests(undefined);
  setOwnerReplySenderForTests(undefined);
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
  // One channel: BARRY's replies and the owner's replies go through the same WhatsApp sender.
  const sender = capture();
  setOwnerReplySenderForTests(() => sender);
  return { ...r, model, id, phone, msg, sender };
}

const load = async (id: string) => (await getConversationStore().get(id))!;
const roles = async (id: string) => (await load(id)).messages.map((m) => `${m.role}:${m.content}`);
const tick = () => new Promise((r) => setImmediate(r));
let req = 0;
const rid = () => `req-${++req}`;

/** Every BARRY message comes before the owner's first message: BARRY never spoke after the person took over. */
async function barrySilentAfterOwner(id: string) {
  const msgs = (await load(id)).messages;
  const firstOwner = msgs.findIndex((m) => m.role === "owner");
  if (firstOwner < 0) return true;
  return !msgs.slice(firstOwner).some((m) => m.role === "barry");
}

describe("handoff blocks autonomous replies immediately", () => {
  it("a runtime handoff gives the conversation to a person in the same save — the very next message is held, no model call, no send", async () => {
    const t = tenant();
    expect((await processInbound(t.msg("hello"), t.sender)).status).toBe("processed");
    await updateConversation(t.id, (s) => createHandoff(t.g, s, { trigger: "customer_asked", reason: "wants a person" }));
    const state = await load(t.id);
    expect(readControl(state)).toMatchObject({ holder: "human", by: "barry" });
    const sendsBefore = t.sender.sent.length;
    const seenBefore = t.model.seen.length;
    const r = await processInbound(t.msg("is anyone there?"), t.sender);
    expect(r.status).toBe("held");
    expect(t.sender.sent).toHaveLength(sendsBefore);
    expect(t.model.seen).toHaveLength(seenBefore);
    const after = await load(t.id);
    expect(after.messages.at(-1)).toMatchObject({ role: "customer", content: "is anyone there?" });
    expect(after.turns.at(-1)?.trace?.stop.reason).toBe("human_in_control");
    expect((await inbox.listByConversation(t.id)).find((x) => x.providerMessageId.endsWith(".2"))?.status).toBe("skipped");
  });

  it("handoff while the customer is typing: the turn already running finishes; every later message is held", async () => {
    const t = tenant();
    const gate = t.model.gate("I want to talk to the owner");
    const typing = processInbound(t.msg("I want to talk to the owner"), t.sender);
    await gate.entered;
    // The owner takes over while BARRY's turn is mid-flight: it waits for the lock — never interleaves.
    const takeOver = ownerTakeOver(t.g, t.id, "owner (web)");
    await tick();
    gate.release();
    expect((await typing).status).toBe("processed");
    await takeOver;
    const sends = t.sender.sent.length;
    expect(sends).toBe(1);
    for (const text of ["hello?", "are you there"]) expect((await processInbound(t.msg(text), t.sender)).status).toBe("held");
    expect(t.sender.sent).toHaveLength(sends);
    expect(humanHolds(await load(t.id))).toBe(true);
  });
});

describe("customer messages during a handoff", () => {
  it("a burst of messages is stored in order, every one held (inbox 'skipped'), none answered, no model call", async () => {
    const t = tenant();
    await processInbound(t.msg("hello"), t.sender);
    await ownerTakeOver(t.g, t.id, "owner (web)");
    const seen = t.model.seen.length;
    const results = await Promise.all(["one", "two", "three"].map((x) => processInbound(t.msg(x), t.sender)));
    expect(results.map((r) => r.status)).toEqual(["held", "held", "held"]);
    expect(t.model.seen).toHaveLength(seen);
    expect(t.sender.sent).toHaveLength(1);
    const state = await load(t.id);
    expect(state.messages.filter((m) => m.role === "customer").map((m) => m.content)).toEqual(["hello", "one", "two", "three"]);
    const stamps = readInboundTurns(state.knownFields);
    expect(Object.values(stamps).filter((s) => s.held)).toHaveLength(3);
    expect((await inbox.listByConversation(t.id)).filter((r) => r.status === "skipped")).toHaveLength(3);
    // A provider re-delivery of a held message is a duplicate — never answered later by accident.
    expect((await processInbound(t.msg("one", `wamid.in.${t.phone}.2`), t.sender)).status).toBe("duplicate");
    expect((await inbox.listByConversation(t.id)).filter((r) => r.status === "skipped")).toHaveLength(3);
    expect(t.sender.sent).toHaveLength(1);
  });
});

describe("owner replies through BARRY's channel", () => {
  it("the owner's reply goes to the customer once, is stored as the owner's (with author) — never as BARRY's", async () => {
    const t = tenant();
    await processInbound(t.msg("hello"), t.sender);
    const barryBefore = (await load(t.id)).messages.filter((m) => m.role === "barry").length;
    const r = await ownerReply(t.g, t.id, { requestId: rid(), text: "Hi, it's Dana — I'll take it from here", by: "owner (web)" });
    expect(r.status).toBe("sent");
    expect(t.sender.sent.at(-1)).toEqual({ to: t.phone, text: "Hi, it's Dana — I'll take it from here" });
    const state = await load(t.id);
    expect(state.messages.at(-1)).toMatchObject({ role: "owner", author: "owner (web)", content: "Hi, it's Dana — I'll take it from here" });
    expect(state.messages.filter((m) => m.role === "barry")).toHaveLength(barryBefore);
    expect(readDeliveries(state.knownFields).at(-1)).toMatchObject({ inboundId: `owner:${r.requestId}`, status: "sent" });
    // Replying takes the conversation: BARRY stays silent now.
    expect(readControl(state)).toMatchObject({ holder: "human", by: "owner (web)" });
    expect((await processInbound(t.msg("thanks Dana"), t.sender)).status).toBe("held");
  });

  it("owner replies while a BARRY turn is queued: BARRY never speaks after the owner did", async () => {
    const t = tenant();
    await processInbound(t.msg("hello"), t.sender);
    const gate = t.model.gate("do you have it in M?");
    const first = processInbound(t.msg("do you have it in M?"), t.sender);
    await gate.entered;
    const queued = processInbound(t.msg("and in L?"), t.sender, { waitMs: 5000 });
    const owner = ownerReply(t.g, t.id, { requestId: rid(), text: "Let me check the back room for you", by: "owner (web)" });
    await tick();
    gate.release();
    const [a, b, o] = await Promise.all([first, queued, owner]);
    expect(a.status).toBe("processed");
    expect(o.status).toBe("sent");
    expect(["processed", "held"]).toContain(b.status);
    expect(await barrySilentAfterOwner(t.id)).toBe(true);
    expect(await roles(t.id)).toContain("customer:and in L?");
    // Exactly one send per BARRY reply + the owner's one.
    const state = await load(t.id);
    expect(t.sender.sent).toHaveLength(state.messages.filter((m) => m.role === "barry" || m.role === "owner").length);
  });

  it("simultaneous owner reply and BARRY turn: serialized; no double-send; BARRY silent after the owner", async () => {
    const t = tenant();
    await processInbound(t.msg("hello"), t.sender);
    for (let i = 0; i < 5; i++) {
      await Promise.all([processInbound(t.msg(`question ${i}`), t.sender), ownerReply(t.g, t.id, { requestId: rid(), text: `answer ${i}`, by: "owner (web)" })]);
      expect(await barrySilentAfterOwner(t.id)).toBe(true);
    }
    const state = await load(t.id);
    expect(state.messages.filter((m) => m.role === "owner")).toHaveLength(5);
    expect(state.messages.filter((m) => m.role === "customer")).toHaveLength(6);
    expect(t.sender.sent).toHaveLength(state.messages.filter((m) => m.role === "barry" || m.role === "owner").length);
  }, 30_000);

  it("retry of an owner reply (same request): sent once; an interrupted send is reported unknown and never re-sent", async () => {
    const t = tenant();
    await processInbound(t.msg("hello"), t.sender);
    const id = rid();
    const [x, y] = await Promise.all([ownerReply(t.g, t.id, { requestId: id, text: "On my way", by: "owner (web)" }), ownerReply(t.g, t.id, { requestId: id, text: "On my way", by: "owner (web)" })]);
    expect(x.status).toBe("sent");
    expect(y.status).toBe("sent");
    expect(t.sender.sent.filter((s) => s.text === "On my way")).toHaveLength(1);
    expect((await load(t.id)).messages.filter((m) => m.role === "owner")).toHaveLength(1);
    // A crash after "sending" was persisted (the process died mid-call): the retry reports unknown, sends nothing.
    const crashed = rid();
    await updateConversation(t.id, (s) => writeOwnerReply(s, { requestId: crashed, by: "owner (web)", text: "lost?", status: "sending", at: new Date().toISOString() }));
    const sends = t.sender.sent.length;
    const r = await ownerReply(t.g, t.id, { requestId: crashed, text: "lost?", by: "owner (web)" });
    expect(r.status).toBe("unknown");
    expect(t.sender.sent).toHaveLength(sends);
  });

  it("failure during an owner send: recorded as failed, not shown as said, the person still holds it; a new attempt sends", async () => {
    const t = tenant();
    await processInbound(t.msg("hello"), t.sender);
    t.sender.fail = true;
    const r = await ownerReply(t.g, t.id, { requestId: rid(), text: "Here's the link", by: "owner (web)" });
    expect(r.status).toBe("failed");
    let state = await load(t.id);
    expect(state.messages.some((m) => m.role === "owner")).toBe(false);
    expect(readDeliveries(state.knownFields).at(-1)).toMatchObject({ status: "failed", inboundId: `owner:${r.requestId}` });
    expect(readOwnerReplies(state)[r.requestId].status).toBe("failed");
    expect(humanHolds(state)).toBe(true);
    // The same request again does not retry silently — it reports the failure. A new request sends.
    expect((await ownerReply(t.g, t.id, { requestId: r.requestId, text: "Here's the link", by: "owner (web)" })).status).toBe("failed");
    t.sender.fail = false;
    expect((await ownerReply(t.g, t.id, { requestId: rid(), text: "Here's the link", by: "owner (web)" })).status).toBe("sent");
    state = await load(t.id);
    expect(state.messages.filter((m) => m.role === "owner")).toHaveLength(1);
  });

  it("a dry-run channel marks the owner's message 'not sent' — never shown as delivered", async () => {
    const t = tenant();
    await processInbound(t.msg("hello"), t.sender);
    setOwnerReplySenderForTests(() => ({ channel: "whatsapp", mode: "dry_run", send: async () => ({}) }));
    const r = await ownerReply(t.g, t.id, { requestId: rid(), text: "test reply", by: "owner (web)" });
    expect(r.status).toBe("dry_run");
    const owner = truthfulTranscript(await load(t.id)).find((m) => m.role === "owner");
    expect(owner?.notSent).toBe("dry_run");
  });

  it("outside WhatsApp's 24h window a live free-text reply is refused before anything is written or sent", async () => {
    const t = tenant();
    await processInbound(t.msg("hello"), t.sender);
    const sends = t.sender.sent.length;
    const later = new Date(Date.now() + 25 * 3600_000);
    await expect(ownerReply(t.g, t.id, { requestId: rid(), text: "still interested?", by: "owner (web)" }, { now: later })).rejects.toBeInstanceOf(OwnerControlError);
    expect(t.sender.sent).toHaveLength(sends);
    expect(humanHolds(await load(t.id))).toBe(false);
  });

  it("an empty reply and another business's conversation are refused", async () => {
    const t = tenant();
    await processInbound(t.msg("hello"), t.sender);
    await expect(ownerReply(t.g, t.id, { requestId: rid(), text: "  ", by: "o" })).rejects.toMatchObject({ code: "empty" });
    const other = getBusinessGraph("spa");
    await expect(ownerReply(other, t.id, { requestId: rid(), text: "hi", by: "o" })).rejects.toMatchObject({ code: "not_found" });
    await expect(ownerTakeOver(other, t.id, "o")).rejects.toMatchObject({ code: "not_found" });
    expect(humanHolds(await load(t.id))).toBe(false);
  });
});

describe("resolve + resume, and the audit trail", () => {
  it("resolving a handoff does not hand back; an explicit return does — then BARRY answers again; every change is logged", async () => {
    const t = tenant();
    await processInbound(t.msg("hello"), t.sender);
    await updateConversation(t.id, (s) => createHandoff(t.g, s, { trigger: "customer_asked", reason: "wants a person" }));
    const handoffId = readHandoffs(await load(t.id))[0].id;
    await ownerReply(t.g, t.id, { requestId: rid(), text: "Hi, Dana here", by: "owner (web)" });
    await updateConversation(t.id, (s) => resolveHandoff(s, handoffId, "owner"));
    expect(humanHolds(await load(t.id))).toBe(true);
    expect((await processInbound(t.msg("ok thanks"), t.sender)).status).toBe("held");

    await ownerReturnToBarry(t.g, t.id, "owner (web)");
    const back = await load(t.id);
    expect(readControl(back)).toMatchObject({ holder: "barry", by: "owner (web)" });
    expect(readHandoffs(back).every((h) => h.status === "resolved")).toBe(true);
    const r = await processInbound(t.msg("one more question"), t.sender);
    expect(r.status).toBe("processed");
    expect((await load(t.id)).messages.at(-1)?.role).toBe("barry");

    const log = readControlLog(await load(t.id));
    expect(log.map((e) => `${e.from}->${e.to} by ${e.by}`)).toEqual(["barry->human by barry", "human->barry by owner (web)"]);
    expect(log[0].handoffId).toBe(handoffId);
    expect(log.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true);
  });

  it("returning an open handoff closes it (resolved by the person) — never a dangling open handoff while BARRY replies", async () => {
    const t = tenant();
    await processInbound(t.msg("hello"), t.sender);
    await updateConversation(t.id, (s) => createHandoff(t.g, s, { trigger: "customer_asked", reason: "wants a person" }));
    await ownerReturnToBarry(t.g, t.id, "owner (web)");
    const h = readHandoffs(await load(t.id))[0];
    expect(h).toMatchObject({ status: "resolved", resolvedBy: "owner (web)" });
  });

  it("legacy records: an open handoff with no control record reads as held by a person (the safe reading)", async () => {
    const t = tenant();
    await processInbound(t.msg("hello"), t.sender);
    await updateConversation(t.id, (s) => {
      createHandoff(t.g, s, { trigger: "customer_asked", reason: "wants a person" });
      delete s.knownFields.__control;
      delete s.knownFields.__controlLog;
    });
    expect(humanHolds(await load(t.id))).toBe(true);
    expect((await processInbound(t.msg("hi?"), t.sender)).status).toBe("held");
  });
});

describe("one ownership state for every surface", () => {
  it("the owner's web view reads the same holder, the owner's message (as theirs) and the log", async () => {
    const t = tenant();
    await processInbound(t.msg("hello"), t.sender);
    await ownerReply(t.g, t.id, { requestId: rid(), text: "Dana here", by: "owner (web)" });
    const view = await getOwnerConversation(t.g, t.id);
    expect(view?.control).toMatchObject({ holder: "human", by: "owner (web)" });
    expect(view?.messages.at(-1)).toMatchObject({ from: "owner", author: "owner (web)", text: "Dana here" });
    expect(view?.controlLog).toHaveLength(1);
  });

  it("BARRY's owner-approval resume is refused while a person holds the conversation — nothing runs", async () => {
    const t = tenant();
    const SCRIPT: Record<string, object> = {
      "the midnight dress": { commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true },
      "add it in M": { commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true },
      "could you ask the owner to approve 10% off this dress?": { constraints: { discountPct: 10 }, advancesTransaction: true, asks: [{ ask: "10% off this dress", kind: "change", coveredByThisIR: true }] },
    };
    t.model.plan = (ctx) => SCRIPT[ctx.customerMessage ?? ""] as never;
    for (const text of Object.keys(SCRIPT)) await processInbound(t.msg(text), t.sender);
    const [approval] = (await getBackend().listApprovals(t.g.business.id)).filter((a) => a.conversationId === t.id);
    expect(approval?.status).toBe("pending");
    await ownerTakeOver(t.g, t.id, "owner (web)");
    const sends = t.sender.sent.length;
    await expect(resumeAfterApproval(t.g, approval.id, "approved", "owner")).rejects.toBeInstanceOf(HumanHoldsConversationError);
    expect((await getBackend().getApproval(approval.id))?.status).toBe("pending");
    expect(t.sender.sent).toHaveLength(sends);
    // Given back to BARRY, the decision goes through.
    await ownerReturnToBarry(t.g, t.id, "owner (web)");
    await resumeAfterApproval(t.g, approval.id, "approved", "owner");
    expect((await getBackend().getApproval(approval.id))?.status).toBe("approved");
  });
});
