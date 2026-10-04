import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import "@/lib/fabric";
import { handleCustomerMessage, readInboundTurns } from "@/lib/runtime";
import { setReasonerForTests, type ReasonerContext } from "@/lib/reasoner";
import { getConversationStore, ConversationConflictError } from "@/lib/state";
import { ConcurrencyGuardMissingError, ConversationBusyError, SupabaseLockStore } from "@/lib/state/lock";
import { updateConversation } from "@/lib/state/update";
import { getInboxStore, InboxStageConflictError, SupabaseInboxStore } from "@/lib/channels/inbox";
import { processInbound, readDeliveries, type OutboundSender } from "@/lib/channels/gateway";
import { acknowledgeHandoff, createHandoff, readHandoffs } from "@/lib/runtime/handoff";
import { setBusinessGraphResolverForTests } from "@/lib/business-graph-repository";
import { getBusinessGraph } from "@/lib/fixtures";
import { getSupabaseClient } from "@/lib/store/supabase-client";
import { ownerReply, ownerReturnToBarry, setOwnerReplySenderForTests } from "@/lib/owner/human-control";
import { giveToHuman, readControl, readControlLog } from "@/lib/runtime/control";
import { ScriptedModel, isolatedRetailer } from "./support/scripted-model";

/**
 * SUPABASE-PATH ACCEPTANCE (opt-in: BARRY_SUPABASE_ACCEPTANCE=1 with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 * pointing at a PREVIEW database that has migration 0019). Runs the app's REAL Supabase code — supabase-js,
 * the Supabase conversation store, conversation locks and the inbound inbox — over HTTP against the database,
 * then proves what was STORED by reading the rows back. Synthetic data only (a fresh isolated test business).
 * Never point it at Production.
 *
 * BARRY_SUPABASE_ACCEPTANCE=guard-missing runs only the fail-closed check, for a database WITHOUT the
 * concurrency guard's functions.
 */

const MODE = process.env.BARRY_SUPABASE_ACCEPTANCE;
const run = MODE === "1" && Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const runGuardMissing = MODE === "guard-missing" && Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
/** A database with 0019 but WITHOUT 0020 (human handoff): owner replies must refuse before sending. */
const runOwnerGuardMissing = MODE === "owner-guard-missing" && Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

class GatedModel extends ScriptedModel {
  private gates = new Map<string, { entered: () => void; release: Promise<boolean> }>();
  seen: string[] = [];
  constructor() {
    super(() => undefined);
  }
  gate(message: string) {
    let entered!: () => void;
    let release!: (fail: boolean) => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    this.gates.set(message, { entered, release: new Promise<boolean>((r) => (release = r)) });
    return { entered: enteredP, release: () => release(false), fail: () => release(true) };
  }
  override async understandDetailed(ctx: ReasonerContext) {
    const msg = ctx.customerMessage ?? "";
    this.seen.push(msg);
    const g = this.gates.get(msg);
    if (g) {
      this.gates.delete(msg);
      g.entered();
      if (await g.release) throw new Error("model call timed out");
    }
    return super.understandDetailed(ctx);
  }
}

const sender = () => {
  const sent: { to: string; text: string }[] = [];
  const s: OutboundSender & { sent: typeof sent } = { channel: "whatsapp", mode: "live", sent, send: async (to, text) => (sent.push({ to, text }), { providerMessageId: `wamid.out.${to}.${sent.length}` }) };
  return s;
};

const db = () => getSupabaseClient();
async function rows<T = Record<string, unknown>>(table: string, col: string, value: string): Promise<T[]> {
  const { data, error } = await db().from(table).select("*").eq(col, value);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as T[];
}

describe.runIf(run)("Supabase path: the real stores against a Preview database with migration 0019", () => {
  let model: GatedModel;
  let g: ReturnType<typeof isolatedRetailer>["g"];
  let dispose: () => void;
  const evidence: Record<string, unknown> = {};
  let n = 0;
  const phoneOf = () => `97250${String(Date.now()).slice(-6)}${n++}`;
  const msgFor = (phone: string) => {
    let k = 0;
    return (text: string, inboundId = `wamid.acc.${phone}.${++k}`) => ({ businessId: g.business.id, conversationId: `wa:${g.business.id}:${phone}`, customerId: `wa:${phone}`, identity: { channel: "whatsapp" as const, channelUserId: phone, verifiedIdentifier: `phone:${phone}` }, text, receivedAt: new Date().toISOString(), inboundId });
  };

  beforeAll(() => {
    const r = isolatedRetailer();
    g = r.g;
    dispose = r.dispose;
    setBusinessGraphResolverForTests((id) => (id === g.business.id ? g : getBusinessGraph(id)));
    model = new GatedModel();
    setReasonerForTests(model);
  });
  afterAll(() => {
    console.log("[acceptance evidence]", JSON.stringify(evidence, null, 2));
    setReasonerForTests(undefined);
    setBusinessGraphResolverForTests(undefined);
    dispose?.();
  });

  it("3 rapid inbound messages to one conversation: stored in order, every turn / reply / delivery / inbox record kept, one reply each", async () => {
    const phone = phoneOf();
    const msg = msgFor(phone);
    const id = `wa:${g.business.id}:${phone}`;
    const out = sender();
    const gate = model.gate("hi there");
    const first = processInbound(msg("hi there"), out);
    await gate.entered;
    const second = processInbound(msg("I want the midnight dress"), out);
    const third = processInbound(msg("size M please"), out);
    await new Promise((r) => setTimeout(r, 300));
    gate.release();
    expect((await Promise.all([first, second, third])).map((r) => r.status)).toEqual(["processed", "processed", "processed"]);

    const [convo] = await rows<{ version: number; known_fields: Record<string, string> }>("conversations", "id", id);
    const messages = await rows<{ role: string; content: string }>("messages", "conversation_id", id);
    const turns = await rows("turn_logs", "conversation_id", id);
    const inbox = await rows<{ status: string; provider_message_id: string }>("conversation_inbox", "conversation_id", id);
    const deliveries = readDeliveries(convo.known_fields);
    expect(messages.filter((m) => m.role === "customer").map((m) => m.content)).toEqual(["hi there", "I want the midnight dress", "size M please"]);
    expect(messages.filter((m) => m.role === "barry")).toHaveLength(3);
    expect(turns).toHaveLength(3);
    expect(deliveries.map((d) => d.status)).toEqual(["sent", "sent", "sent"]);
    expect(Object.keys(readInboundTurns(convo.known_fields))).toHaveLength(3);
    expect(inbox.map((r) => r.status)).toEqual(["sent", "sent", "sent"]);
    expect(out.sent).toHaveLength(3);
    expect(new Set(out.sent.map((s) => s.text)).size === out.sent.length || out.sent.length === 3).toBe(true);
    const [lock] = await rows<{ expires_at: string }>("conversation_locks", "conversation_id", id);
    expect(Date.parse(lock.expires_at)).toBeLessThan(Date.now());
    evidence.burst = { conversation: id, version: convo.version, customerMessages: 3, barryMessages: messages.filter((m) => m.role === "barry").length, turns: turns.length, deliveries: deliveries.map((d) => d.status), inbox: inbox.map((r) => r.status), repliesSent: out.sent.length, lockReleased: true };
  });

  it("duplicate provider message id (concurrent and later): one inbox row, one turn, one reply", async () => {
    const phone = phoneOf();
    const msg = msgFor(phone);
    const id = `wa:${g.business.id}:${phone}`;
    const out = sender();
    const m = msg("hello once", `wamid.acc.dup.${phone}`);
    const gate = model.gate("hello once");
    const a = processInbound(m, out);
    await gate.entered;
    const b = processInbound(m, out);
    await new Promise((r) => setTimeout(r, 300));
    gate.release();
    const statuses = (await Promise.all([a, b])).map((r) => r.status).sort();
    expect(statuses).toEqual(["duplicate", "processed"]);
    expect((await processInbound(m, out)).status).toBe("duplicate");
    expect(await rows("conversation_inbox", "conversation_id", id)).toHaveLength(1);
    expect(await rows("turn_logs", "conversation_id", id)).toHaveLength(1);
    expect(out.sent).toHaveLength(1);
    evidence.duplicate = { deliveries: 3, statuses: [...statuses, "duplicate"], inboxRows: 1, turns: 1, repliesSent: out.sent.length };
  });

  it("two conversations concurrently: B is answered while A's turn holds A's lock", async () => {
    const pa = phoneOf();
    const pb = phoneOf();
    const out = sender();
    const gate = model.gate("from A");
    const ra = processInbound(msgFor(pa)("from A"), out);
    await gate.entered;
    const rb = await processInbound(msgFor(pb)("from B"), out);
    expect(rb.status).toBe("processed");
    gate.release();
    expect((await ra).status).toBe("processed");
    expect(await rows("turn_logs", "conversation_id", `wa:${g.business.id}:${pb}`)).toHaveLength(1);
    evidence.twoConversations = { bAnsweredWhileAHeld: true };
  });

  it("owner action while the conversation is busy: refused when it can't wait, applied after the turn when it can — both kept", async () => {
    const phone = phoneOf();
    const msg = msgFor(phone);
    const id = `wa:${g.business.id}:${phone}`;
    const out = sender();
    expect((await processInbound(msg("first message"), out)).status).toBe("processed");
    const gate = model.gate("still there?");
    const turn = processInbound(msg("still there?"), out);
    await gate.entered;
    // The owner takes the conversation while BARRY's turn holds it: refused when it can't wait…
    await expect(updateConversation(id, (s) => giveToHuman(s, "owner", "taking over"), { waitMs: 50 })).rejects.toBeInstanceOf(ConversationBusyError);
    // …applied right after the turn when it can.
    const owner = updateConversation(id, (s) => createHandoff(g, s, { trigger: "customer_asked", reason: "owner took over", urgency: "normal", unresolved: [] }).handoff, { waitMs: 30_000 });
    await new Promise((r) => setTimeout(r, 300));
    gate.release();
    const [, created] = await Promise.all([turn, owner]);
    const handoffId = created!.result.id;
    await updateConversation(id, (s) => acknowledgeHandoff(s, handoffId, "owner"));
    const [convo] = await rows<{ known_fields: Record<string, string> }>("conversations", "id", id);
    const state = { knownFields: convo.known_fields } as never;
    expect(readHandoffs(state).find((h) => h.id === handoffId)?.status).toBe("acknowledged");
    expect(readControl(state).holder).toBe("human");
    const customer = (await rows<{ role: string; content: string }>("messages", "conversation_id", id)).filter((m) => m.role === "customer").map((m) => m.content);
    expect(customer).toEqual(["first message", "still there?"]);
    evidence.ownerWhileBusy = { refusedWhenNoWait: true, appliedAfterTurn: true, handoff: "acknowledged", customerMessages: customer.length };
  });

  it("retry after a partial failure: model timeout (nothing saved, nothing sent) → retry answers once; send succeeded but its stage write failed → retry never re-sends", async () => {
    const phone = phoneOf();
    const msg = msgFor(phone);
    const id = `wa:${g.business.id}:${phone}`;
    const out = sender();
    const m1 = msg("are you open?", `wamid.acc.timeout.${phone}`);
    const gate = model.gate("are you open?");
    const first = processInbound(m1, out);
    await gate.entered;
    gate.fail();
    expect(await first).toMatchObject({ status: "failed", retry: true });
    expect(out.sent).toHaveLength(0);
    expect((await processInbound(m1, out)).status).toBe("processed");
    expect(out.sent).toHaveLength(1);

    const m2 = msg("do you ship?", `wamid.acc.sendsaved.${phone}`);
    const realUpdate = SupabaseInboxStore.prototype.update;
    const spy = vi.spyOn(SupabaseInboxStore.prototype, "update").mockImplementation(function (this: SupabaseInboxStore, rowId, patch, from) {
      if (patch.status === "sent") {
        spy.mockRestore();
        return Promise.reject(new Error("database blip after the send"));
      }
      return realUpdate.call(this, rowId, patch, from);
    });
    await processInbound(m2, out);
    expect(out.sent).toHaveLength(2);
    const stuck = (await rows<{ provider_message_id: string; status: string }>("conversation_inbox", "conversation_id", id)).find((r) => r.provider_message_id === m2.inboundId);
    expect(stuck?.status).toBe("sending");
    await processInbound(m2, out);
    expect(out.sent).toHaveLength(2);
    const fixed = (await rows<{ provider_message_id: string; status: string }>("conversation_inbox", "conversation_id", id)).find((r) => r.provider_message_id === m2.inboundId);
    expect(fixed?.status).toBe("sent");
    expect(await rows("turn_logs", "conversation_id", id)).toHaveLength(2);
    evidence.partialFailure = { timeoutRetriedOnce: true, sendSucceededBookkeepingFailed: { stuckAt: "sending", afterRetry: "sent", repliesSent: 1 } };
  });

  it("lock contention, inbox dedupe and forward-only stages, version conflict — at the database", async () => {
    const locks = new SupabaseLockStore();
    const cid = `acc-lock-${Date.now()}`;
    expect(await locks.tryAcquire(cid, "A", 60_000)).toBe(true);
    expect(await locks.tryAcquire(cid, "B", 60_000)).toBe(false);
    expect(await locks.tryAcquire(cid, "A", 60_000)).toBe(true);
    await locks.release(cid, "B");
    expect(await locks.tryAcquire(cid, "B", 60_000)).toBe(false);
    await locks.release(cid, "A");
    expect(await locks.tryAcquire(cid, "B", 60_000)).toBe(true);
    const short = `acc-lease-${Date.now()}`;
    expect(await locks.tryAcquire(short, "A", 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(await locks.tryAcquire(short, "C", 60_000)).toBe(true);

    const inbox = getInboxStore();
    const base = { businessId: g.business.id, conversationId: `acc-inbox-${Date.now()}`, channel: "whatsapp", providerMessageId: `wamid.acc.inbox.${Date.now()}`, customerId: "c", body: "x", meta: {}, receivedAt: new Date().toISOString() };
    const a = await inbox.claim(base);
    const b = await inbox.claim({ ...base, body: "a different body" });
    expect([a.created, b.created]).toEqual([true, false]);
    expect(b.row.body).toBe("x");
    await inbox.update(a.row.id, { status: "processing" }, "received");
    await inbox.update(a.row.id, { status: "sent" }, "processing");
    await expect(inbox.update(a.row.id, { status: "failed" }, "processing")).rejects.toBeInstanceOf(InboxStageConflictError);
    expect((await inbox.get(a.row.id))?.status).toBe("sent");

    const store = getConversationStore();
    const vid = `acc-version-${Date.now()}`;
    await store.getOrCreate(vid, g.business.id, "c");
    const x = (await store.get(vid))!;
    const y = (await store.get(vid))!;
    x.knownFields.kept = "yes";
    await store.save(x);
    y.knownFields.overwrite = "would erase kept";
    await expect(store.save(y)).rejects.toBeInstanceOf(ConversationConflictError);
    const [row] = await rows<{ known_fields: Record<string, string>; version: number }>("conversations", "id", vid);
    expect(row.known_fields).toMatchObject({ kept: "yes" });
    expect(row.known_fields.overwrite).toBeUndefined();
    evidence.database = { lock: "acquire/contend/re-enter/holder-only release/expired takeover", inbox: "unique claim + forward-only stage", version: { stored: row.version, staleSaveRefused: true } };
  });

  it("human handoff (0020): held messages stored, owner reply stored as the owner's, BARRY silent until returned, control log kept", async () => {
    const phone = phoneOf();
    const msg = msgFor(phone);
    const id = `wa:${g.business.id}:${phone}`;
    const out = sender();
    setOwnerReplySenderForTests(() => out);
    try {
      expect((await processInbound(msg("hello"), out)).status).toBe("processed");
      await updateConversation(id, (s) => createHandoff(g, s, { trigger: "customer_asked", reason: "wants a person" }));
      const seen = model.seen.length;
      const held = await Promise.all(["one", "two", "three"].map((x) => processInbound(msg(x), out)));
      expect(held.map((r) => r.status)).toEqual(["held", "held", "held"]);
      expect(model.seen).toHaveLength(seen);
      const [reply, racing] = await Promise.all([ownerReply(g, id, { requestId: `acc-${phone}-1`, text: "Hi, Dana here", by: "owner (web)" }), processInbound(msg("are you there?"), out)]);
      expect(reply.status).toBe("sent");
      expect(racing.status).toBe("held");
      // The same owner request again: no second send.
      expect((await ownerReply(g, id, { requestId: `acc-${phone}-1`, text: "Hi, Dana here", by: "owner (web)" })).status).toBe("sent");
      expect(out.sent.filter((x) => x.text === "Hi, Dana here")).toHaveLength(1);
      await ownerReturnToBarry(g, id, "owner (web)");
      expect((await processInbound(msg("one more thing"), out)).status).toBe("processed");

      const msgs = await rows<{ role: string; content: string; author: string | null }>("messages", "conversation_id", id);
      const owner = msgs.filter((m) => m.role === "owner");
      expect(owner).toEqual([expect.objectContaining({ content: "Hi, Dana here", author: "owner (web)" })]);
      expect(msgs.filter((m) => m.role === "customer").map((m) => m.content).sort()).toEqual(["are you there?", "hello", "one", "one more thing", "three", "two"].sort());
      const inboxRows = await rows<{ status: string }>("conversation_inbox", "conversation_id", id);
      expect(inboxRows.filter((r) => r.status === "skipped")).toHaveLength(4);
      const state = (await getConversationStore().get(id))!;
      expect(readControl(state).holder).toBe("barry");
      expect(readControlLog(state).map((e) => `${e.from}->${e.to}`)).toEqual(["barry->human", "human->barry"]);
      expect(readDeliveries(state.knownFields).filter((d) => d.inboundId.startsWith("owner:"))).toHaveLength(1);
      evidence.handoff = {
        customerMessages: msgs.filter((m) => m.role === "customer").length,
        heldInboxRows: inboxRows.filter((r) => r.status === "skipped").length,
        ownerMessages: owner.length,
        barryMessages: msgs.filter((m) => m.role === "barry").length,
        sends: out.sent.length,
        controlLog: readControlLog(state).map((e) => `${e.from}->${e.to} by ${e.by}`),
      };
    } finally {
      setOwnerReplySenderForTests(undefined);
    }
  });

  it("a plain web/simulator turn on the same path also stores everything", async () => {
    const id = `sim-acc-${Date.now()}`;
    await handleCustomerMessage(g, id, "c-web", "hello from the web chat");
    const [convo] = await rows<{ version: number }>("conversations", "id", id);
    expect(convo.version).toBeGreaterThan(0);
    expect(await rows("turn_logs", "conversation_id", id)).toHaveLength(1);
  });
});

describe.runIf(runGuardMissing)("Supabase path WITHOUT the concurrency guard: fail closed", () => {
  it("refuses every conversation write and sends nothing", async () => {
    const r = isolatedRetailer();
    setBusinessGraphResolverForTests((id) => (id === r.g.business.id ? r.g : getBusinessGraph(id)));
    const model = new GatedModel();
    setReasonerForTests(model);
    const out = sender();
    const phone = `97259${String(Date.now()).slice(-7)}`;
    const m = { businessId: r.g.business.id, conversationId: `wa:${r.g.business.id}:${phone}`, customerId: `wa:${phone}`, identity: { channel: "whatsapp" as const, channelUserId: phone }, text: "hi", receivedAt: new Date().toISOString(), inboundId: `wamid.guard.${phone}` };
    await expect(processInbound(m, out)).rejects.toBeInstanceOf(ConcurrencyGuardMissingError);
    await expect(handleCustomerMessage(r.g, `sim-guard-${Date.now()}`, "c", "hi")).rejects.toBeInstanceOf(ConcurrencyGuardMissingError);
    expect(model.seen).toEqual([]);
    expect(out.sent).toEqual([]);
    console.log("[acceptance evidence] guard missing: refused, model calls 0, sent 0");
    setReasonerForTests(undefined);
    setBusinessGraphResolverForTests(undefined);
    r.dispose();
  });
});

describe.runIf(runOwnerGuardMissing)("Supabase path WITHOUT migration 0020: owner replies fail closed", () => {
  it("refuses the owner reply before anything is sent", async () => {
    const r = isolatedRetailer();
    setBusinessGraphResolverForTests((id) => (id === r.g.business.id ? r.g : getBusinessGraph(id)));
    setReasonerForTests(new GatedModel());
    const out = sender();
    setOwnerReplySenderForTests(() => out);
    const id = `sim-owner-guard-${Date.now()}`;
    await handleCustomerMessage(r.g, id, "c", "hi");
    await expect(ownerReply(r.g, id, { requestId: "x", text: "hello", by: "owner (web)" })).rejects.toBeInstanceOf(ConcurrencyGuardMissingError);
    expect(out.sent).toEqual([]);
    console.log("[acceptance evidence] 0020 missing: owner reply refused, sent 0");
    setOwnerReplySenderForTests(undefined);
    setReasonerForTests(undefined);
    setBusinessGraphResolverForTests(undefined);
    r.dispose();
  });
});
