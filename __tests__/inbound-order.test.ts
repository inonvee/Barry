import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { setReasonerForTests, type ReasonerContext } from "@/lib/reasoner";
import { getConversationStore } from "@/lib/state";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests, type NewInbound } from "@/lib/channels/inbox";
import { processInbound, readDeliveries, setInboundSettleMsForTests, type OutboundSender } from "@/lib/channels/gateway";
import { setBusinessGraphResolverForTests } from "@/lib/business-graph-repository";
import { getBusinessGraph } from "@/lib/fixtures";
import { ScriptedModel, isolatedRetailer } from "./support/scripted-model";

/**
 * INBOUND ORDER UNDER CONCURRENT CLAIMS (regression for the deployed acceptance run qa-1791123353799: a
 * same-second burst was processed in reverse because the drain followed the inbox insert sequence, i.e. the
 * order in which concurrent claims happened to reach the database).
 *
 * Deterministic: the inbox delays each claim so the LAST message's claim lands FIRST and the first message's
 * lands last; all three share the provider timestamp second. The conversation must still be processed in the
 * order the messages arrived — and nothing may run or be sent twice.
 */

/** Claims finish out of order: a per-message delay before the insert lands. */
class OutOfOrderInbox extends MemoryInboxStore {
  constructor(private readonly delayFor: (body: string) => number) {
    super();
  }
  override async claim(input: NewInbound) {
    await new Promise((r) => setTimeout(r, this.delayFor(input.body)));
    return super.claim(input);
  }
}

class RecordingModel extends ScriptedModel {
  seen: string[] = [];
  constructor() {
    super(() => undefined);
  }
  override async understandDetailed(ctx: ReasonerContext) {
    this.seen.push(ctx.customerMessage ?? "");
    return super.understandDetailed(ctx);
  }
}

let dispose: (() => void) | undefined;
let inbox: OutOfOrderInbox;
const BURST = ["Is it available in M?", "And in L?", "What does it cost?"];

beforeEach(() => {
  setLockStoreForTests(new MemoryLockStore());
  // First message's claim lands last; the last message's claim lands first.
  inbox = new OutOfOrderInbox((body) => ({ [BURST[0]]: 120, [BURST[1]]: 60, [BURST[2]]: 0 })[body] ?? 0);
  setInboxStoreForTests(inbox);
});
afterEach(() => {
  setInboundSettleMsForTests(undefined);
  setReasonerForTests(undefined);
  setBusinessGraphResolverForTests(undefined);
  setLockStoreForTests(undefined);
  setInboxStoreForTests(undefined);
  dispose?.();
  dispose = undefined;
});

function tenant() {
  const r = isolatedRetailer();
  dispose = r.dispose;
  setBusinessGraphResolverForTests((id) => (id === r.g.business.id ? r.g : getBusinessGraph(id)));
  const model = new RecordingModel();
  setReasonerForTests(model);
  const phone = `9725${Math.floor(Math.random() * 1e8)}`;
  const id = `wa:${r.g.business.id}:${phone}`;
  const sameSecond = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  let n = 0;
  const msg = (text: string) => ({ businessId: r.g.business.id, conversationId: id, customerId: `wa:${phone}`, identity: { channel: "whatsapp" as const, channelUserId: phone }, text, receivedAt: sameSecond, inboundId: `wamid.order.${phone}.${++n}` });
  const sent: string[] = [];
  const sender: OutboundSender = { channel: "whatsapp", mode: "dry_run", send: async (_to, text) => (sent.push(text), {}) };
  return { ...r, model, id, msg, sender, sent };
}

describe("a same-second burst whose claims land out of order", () => {
  it("is processed in arrival order — transcript, turns and model calls — with one turn and one delivery per message", async () => {
    setInboundSettleMsForTests(250);
    const t = tenant();
    const messages = BURST.map((b) => t.msg(b));
    // Delivered concurrently, in this arrival order (the way the webhook receives a burst).
    const results = await Promise.all(messages.map((m) => processInbound(m, t.sender)));
    expect(results.every((r) => r.status === "processed" || r.status === "duplicate")).toBe(true);

    // The race really happened: insert sequence is the REVERSE of arrival.
    const rows = await inbox.listByConversation(t.id);
    const seqOf = (body: string) => rows.find((r) => r.body === body)!.seq;
    expect(seqOf(BURST[2])).toBeLessThan(seqOf(BURST[1]));
    expect(seqOf(BURST[1])).toBeLessThan(seqOf(BURST[0]));

    // …and yet the conversation was handled in the order the customer wrote.
    const state = (await getConversationStore().get(t.id))!;
    expect(state.messages.filter((m) => m.role === "customer").map((m) => m.content)).toEqual(BURST);
    expect(state.turns.map((x) => x.customerMessage)).toEqual(BURST);
    expect(t.model.seen).toEqual(BURST);
    // The inbox reads back in inbound order too (what the drain follows).
    expect(rows.map((r) => r.body)).toEqual(BURST);
    // At most once: one turn, one delivery per inbound; every row finished.
    expect(state.turns).toHaveLength(3);
    for (const m of messages) expect(readDeliveries(state.knownFields).filter((d) => d.inboundId === m.inboundId)).toHaveLength(1);
    expect(rows.every((r) => r.status === "dry_run")).toBe(true);
  });

  it("a provider retry of the first message (after a 500) keeps its original arrival position and never runs twice", async () => {
    setInboundSettleMsForTests(250);
    const t = tenant();
    const messages = BURST.map((b) => t.msg(b));
    await Promise.all(messages.map((m) => processInbound(m, t.sender)));
    const again = await processInbound(messages[0], t.sender);
    expect(again.status).toBe("duplicate");
    const state = (await getConversationStore().get(t.id))!;
    expect(state.turns.map((x) => x.customerMessage)).toEqual(BURST);
    expect(t.sent).toHaveLength(0); // dry run: nothing sent
  });

  it("messages with different provider timestamps are ordered by the provider's time first", async () => {
    setInboundSettleMsForTests(250);
    const t = tenant();
    const base = Math.floor(Date.now() / 1000) * 1000;
    // Arrive in the opposite order of when the customer sent them.
    const later = { ...t.msg(BURST[0]), receivedAt: new Date(base + 2000).toISOString() };
    const earlier = { ...t.msg(BURST[1]), receivedAt: new Date(base).toISOString() };
    await Promise.all([processInbound(later, t.sender), processInbound(earlier, t.sender)]);
    const state = (await getConversationStore().get(t.id))!;
    expect(state.turns.map((x) => x.customerMessage)).toEqual([BURST[1], BURST[0]]);
  });
});
