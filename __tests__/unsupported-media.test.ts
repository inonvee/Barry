import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/fabric";
import { setReasonerForTests, type ReasonerContext } from "@/lib/reasoner";
import { recentConversation } from "@/lib/reasoner/openai-reasoner";
import { getConversationStore } from "@/lib/state";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { MemoryInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { processInbound, readDeliveries, type OutboundSender } from "@/lib/channels/gateway";
import { parseWebhook } from "@/lib/channels/whatsapp";
import { mediaPlaceholder, readMediaEvents } from "@/lib/channels/media";
import { applyControlChange, resetControlsCacheForTests } from "@/lib/hq/controls";
import { ownerTakeOver } from "@/lib/owner/human-control";
import { ownerPause } from "@/lib/owner/mode";
import { getOwnerWorkspace } from "@/lib/owner/service";
import { notifyOwnerAlert } from "@/lib/owner/briefs";
import { createLinkCode } from "@/lib/owner-channel/identity";
import { processOwnerInbound } from "@/lib/owner-channel/gateway";
import type { OwnerOutbound, OwnerSender } from "@/lib/owner-channel/transport";
import { setBusinessGraphResolverForTests } from "@/lib/business-graph-repository";
import { getBusinessGraph } from "@/lib/fixtures";
import type { BusinessGraph } from "@/lib/business-graph";
import { ScriptedModel, isolatedRetailer } from "./support/scripted-model";

/**
 * PAID-PILOT P0 PHASE 7 — UNSUPPORTED MEDIA. A voice note / image / file BARRY can't read: kept, answered
 * honestly once (never "understood"), the owner alerted, the conversation stays coherent — through the same
 * inbox / send-at-most-once path, with no model call.
 */

class CountingModel extends ScriptedModel {
  seen: ReasonerContext[] = [];
  constructor() {
    super(() => undefined);
  }
  override async understandDetailed(ctx: ReasonerContext) {
    this.seen.push(ctx);
    return super.understandDetailed(ctx);
  }
}

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
  while (disposers.length) disposers.pop()!();
  graphs.clear();
});

function tenant() {
  const r = isolatedRetailer();
  disposers.push(r.dispose);
  graphs.set(r.g.business.id, r.g);
  setBusinessGraphResolverForTests((id) => graphs.get(id) ?? getBusinessGraph(id));
  const model = new CountingModel();
  setReasonerForTests(model);
  const phone = `97250${Math.floor(Math.random() * 1e7)}`;
  const routes = { "PNID-1": r.g.business.id };
  const sent: string[] = [];
  const sender: OutboundSender = { channel: "whatsapp", mode: "live", send: async (_to, text) => (sent.push(text), { providerMessageId: `out.${sent.length}` }) };
  let n = 0;
  const webhook = (msg: Record<string, unknown>) => parseWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PNID-1" }, contacts: [{ wa_id: phone, profile: { name: "Noa" } }], messages: [{ id: `wamid.media.${phone}.${++n}`, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), ...msg }] } }] }] }, routes, []);
  return { ...r, model, phone, sent, sender, webhook, id: `wa:${r.g.business.id}:${phone}` };
}

describe("parsing", () => {
  it("voice notes, images (with their caption), files are messages with `media`; a reaction is not a message", () => {
    const t = tenant();
    const voice = t.webhook({ type: "audio", audio: { id: "a1" } });
    expect(voice.messages[0]).toMatchObject({ media: { type: "audio" }, text: "[voice message — not opened]" });
    const image = t.webhook({ type: "image", image: { id: "i1", caption: "do you have this in blue?" } });
    expect(image.messages[0]).toMatchObject({ media: { type: "image", caption: "do you have this in blue?" }, text: "[image — not opened] do you have this in blue?" });
    expect(t.webhook({ type: "document", document: { id: "d1", filename: "x.pdf" } }).messages[0].media?.type).toBe("document");
    const reaction = t.webhook({ type: "reaction", reaction: { emoji: "👍" } });
    expect(reaction.messages).toHaveLength(0);
    expect(reaction.unsupported[0].type).toBe("reaction");
  });
});

describe("the customer sends something BARRY can't read", () => {
  it("kept, answered honestly once (no model call, never 'understood'), owner attention raised; a retry never re-sends", async () => {
    const t = tenant();
    const [m] = t.webhook({ type: "audio", audio: { id: "a1" } }).messages;
    const r = await processInbound(m, t.sender);
    expect(r.status).toBe("processed");
    expect(t.model.seen).toHaveLength(0);
    expect(t.sent).toHaveLength(1);
    // The business is Israeli and the customer wrote no words: the business's language.
    expect(t.sent[0]).toMatch(/can't open voice messages|לא יכול לפתוח הודעות קוליות/);
    expect(t.sent[0]).not.toMatch(/listened|heard|got your (?:voice|message)|understood|שמעתי|הבנתי/i);
    const state = (await getConversationStore().get(t.id))!;
    expect(state.messages.map((x) => x.role)).toEqual(["customer", "barry"]);
    expect(state.messages[0].content).toBe(mediaPlaceholder("audio"));
    expect(readMediaEvents(state)).toEqual([expect.objectContaining({ type: "audio", answered: true })]);
    expect(readDeliveries(state.knownFields).at(-1)).toMatchObject({ inboundId: m.inboundId, status: "sent" });
    // Meta delivers it again: a duplicate — nothing recorded or sent twice.
    expect((await processInbound(m, t.sender)).status).toBe("duplicate");
    expect(t.sent).toHaveLength(1);
    expect((await getConversationStore().get(t.id))!.messages).toHaveLength(2);
    const ws = await getOwnerWorkspace(t.g);
    expect(ws.conversations.find((c) => c.id === t.id)?.attention).toContain("unreadable_media");
  });

  it("answers in the conversation's language", async () => {
    const t = tenant();
    await processInbound(t.webhook({ type: "text", text: { body: "שלום, יש לכם שמלות?" } }).messages[0], t.sender);
    await processInbound(t.webhook({ type: "image", image: { id: "i1" } }).messages[0], t.sender);
    expect(t.sent.at(-1)).toMatch(/לא יכול לפתוח תמונות/);
  });

  it("the conversation stays coherent: the next typed message is handled normally and the model sees the media was not opened", async () => {
    const t = tenant();
    await processInbound(t.webhook({ type: "audio", audio: { id: "a1" } }).messages[0], t.sender);
    const r = await processInbound(t.webhook({ type: "text", text: { body: "sorry — do you have the midnight dress?" } }).messages[0], t.sender);
    expect(r.status).toBe("processed");
    expect(t.model.seen).toHaveLength(1);
    const history = recentConversation(t.model.seen[0]);
    expect(history.some((h) => h.from === "customer" && h.text === "[voice message — not opened]")).toBe(true);
    const ws = await getOwnerWorkspace(t.g);
    expect(ws.conversations.find((c) => c.id === t.id)?.attention ?? []).not.toContain("unreadable_media");
  });

  it("a person holds the conversation: kept, BARRY doesn't answer; paused: kept, nothing sent", async () => {
    const t = tenant();
    await processInbound(t.webhook({ type: "text", text: { body: "hi" } }).messages[0], t.sender);
    await ownerTakeOver(t.g, t.id, "the owner (web)");
    const sends = t.sent.length;
    expect((await processInbound(t.webhook({ type: "image", image: { id: "i1" } }).messages[0], t.sender)).status).toBe("held");
    expect(t.sent).toHaveLength(sends);
    expect((await getConversationStore().get(t.id))!.messages.at(-1)).toMatchObject({ role: "customer", content: mediaPlaceholder("image") });

    const u = tenant();
    await ownerPause(u.g, "the owner (web)");
    expect((await processInbound(u.webhook({ type: "audio", audio: { id: "a1" } }).messages[0], u.sender)).status).toBe("held");
    expect(u.sent).toHaveLength(0);
    expect((await getConversationStore().get(u.id))!.messages.map((x) => x.content)).toEqual([mediaPlaceholder("audio")]);
  });
});

describe("owner alert", () => {
  it("once per message, only for a supervised / live business (a practice business never messages a real owner)", async () => {
    const t = tenant();
    const sent: OwnerOutbound[] = [];
    const owner: OwnerSender = { channel: "whatsapp", mode: "live", send: async (_to, m) => (sent.push(m), { providerMessageId: `o${sent.length}` }) };
    const { code } = await createLinkCode(t.g.business.id);
    expect((await processOwnerInbound({ channel: "whatsapp", messageId: "link-1", channelUserId: "972501110000", verifiedIdentifier: "phone:972501110000", receivedAt: new Date().toISOString(), text: `LINK ${code}` }, owner, { businessIds: [t.g.business.id] })).status).toBe("linked");
    const before = sent.length;
    expect(await notifyOwnerAlert(t.g, "media:x1", "Noa sent a voice message BARRY can't open.", { sender: owner })).toEqual([]);
    await applyControlChange(t.g.business.id, { mode: "supervised" }, { by: "founder", reason: "pilot" });
    const first = await notifyOwnerAlert(t.g, "media:x1", "Noa sent a voice message BARRY can't open.", { sender: owner });
    expect(first.map((r) => r.status)).toEqual(["sent"]);
    expect(await notifyOwnerAlert(t.g, "media:x1", "Noa sent a voice message BARRY can't open.", { sender: owner })).toEqual([]);
    expect(sent.length - before).toBe(1);
  });
});
