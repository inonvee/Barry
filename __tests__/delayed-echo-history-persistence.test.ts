import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/fabric";
import { MemoryLockStore, setLockStoreForTests } from "@/lib/state/lock";
import { getMemoryConversationStore, SupabaseConversationStore, type ConversationStore } from "@/lib/state";
import { readControl, readControlLog } from "@/lib/runtime/control";
import { TEAM_MEMBER, applyPendingTakeovers, listTakeoverSignals, recordEcho } from "@/lib/channels/human-takeover";
import { ownerReturnToBarry } from "@/lib/owner/human-control";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";

/**
 * REGRESSION — deployed run coex-1791367526933, check J (a delayed employee echo after an explicit return).
 *
 * An echo stamped BEFORE the owner's return is history: it must join the transcript as the person's message (in
 * time order — i.e. in the MIDDLE of the transcript), without taking the conversation. On the Preview the durable
 * store is Supabase, whose save() inserted only `messages.slice(previouslyPersistedCount)`: a message spliced into
 * the middle was never written (the already-saved last message was re-inserted instead). The in-memory store hid it.
 * This replays the deployed sequence against BOTH stores — the Supabase one over a fake database with the same
 * contract as migrations 0019/0020 (rows read back ordered by `at`; save appends the given messages).
 */

type Row = Record<string, unknown>;
const db: { conversations: Row[]; messages: Row[]; turn_logs: Row[] } = { conversations: [], messages: [], turn_logs: [] };

function table(name: keyof typeof db) {
  const filters: [string, unknown][] = [];
  let orderBy: string | undefined;
  let inserted: Row | undefined;
  const rows = () => {
    const r = db[name].filter((row) => filters.every(([k, v]) => row[k] === v));
    return orderBy ? [...r].sort((a, b) => String(a[orderBy!]).localeCompare(String(b[orderBy!]))) : r;
  };
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (k: string, v: unknown) => (filters.push([k, v]), b),
    order: (k: string) => ((orderBy = k), b),
    limit: () => b,
    insert: (row: Row) => {
      inserted = { version: 0, ...row };
      db[name].push(inserted);
      return b;
    },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => ({ data: inserted ?? rows()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: inserted ? null : rows(), error: null }),
  };
  return b;
}

vi.mock("@/lib/store/supabase-client", () => ({
  isSupabaseConfigured: () => false,
  getSupabaseClient: () => ({
    from: (name: keyof typeof db) => table(name),
    rpc: async (fn: string, a: { p_id: string; p_expected_version: number; p_row: Row; p_messages: Row[]; p_turns: Row[] }) => {
      if (fn !== "barry_save_conversation") return { data: null, error: { message: `unexpected rpc ${fn}` } };
      const row = db.conversations.find((c) => c.id === a.p_id);
      if (!row || Number(row.version) !== a.p_expected_version) return { data: null, error: null };
      Object.assign(row, a.p_row, { version: Number(row.version) + 1 });
      for (const m of a.p_messages) db.messages.push({ conversation_id: a.p_id, ...m });
      for (const t of a.p_turns) db.turn_logs.push({ conversation_id: a.p_id, ...t });
      return { data: row.version, error: null };
    },
  }),
}));

let store: ConversationStore;
vi.mock("@/lib/state", async (orig) => ({ ...(await orig<typeof import("@/lib/state")>()), getConversationStore: () => store }));

const BIZ = "fashion-retailer";
const LINE = "PN-DELAYED";
beforeEach(() => {
  db.conversations = [];
  db.messages = [];
  db.turn_logs = [];
  setLockStoreForTests(new MemoryLockStore());
});
afterEach(() => setLockStoreForTests(undefined));

describe.each([
  ["Supabase store (the Preview's durable store)", () => new SupabaseConversationStore()],
  ["memory store", () => getMemoryConversationStore()],
])("old delayed echo after an explicit return — %s", (_label, makeStore) => {
  it("is processed once as history_only, stays in the transcript as the PERSON's message, holder stays BARRY, no new takeover", async () => {
    store = makeStore();
    const customer = `99956${Math.floor(Math.random() * 1e6)}`;
    const id = `wa:${BIZ}:${customer}`;
    // As deployed: the whole conversation is seconds old, so an echo stamped 120 s before the return is OLDER than
    // every message already in the transcript and belongs at the very start of it.
    const t0 = Date.now() - 30_000;
    const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString();

    // 1. customer conversation (customer message + BARRY's reply, persisted)
    const s = await store.getOrCreate(id, BIZ, `wa:${customer}`);
    s.messages.push({ role: "customer", content: "Can I book tomorrow?", at: iso(t0) }, { role: "barry", content: "Sure — what time?", at: iso(t0 + 1000) });
    await store.save(s);

    // 2. employee echo → HUMAN
    await recordEcho({ lineId: LINE, businessId: BIZ, messageId: "wamid.e1", customer, at: iso(t0 + 5_000), type: "text", text: "Hi! I'll check tomorrow for you." });
    await applyPendingTakeovers(BIZ, id, `wa:${customer}`);
    expect(readControl((await store.get(id))!).holder).toBe("human");

    // 3. owner returns it to BARRY
    await ownerReturnToBarry(resolveBusinessGraph(BIZ), id, "the owner (web)");
    const afterReturn = (await store.get(id))!;
    const returnedAt = readControlLog(afterReturn).filter((e) => e.to === "barry").map((e) => e.at).at(-1)!;
    expect(readControl(afterReturn).holder).toBe("barry");
    const takeoversBefore = readControlLog(afterReturn).filter((e) => e.to === "human").length;
    expect(takeoversBefore).toBe(1);

    // 4. a later-arriving echo stamped 120 s BEFORE the return
    const lateAt = iso(Date.parse(returnedAt) - 120_000);
    const rec = await recordEcho({ lineId: LINE, businessId: BIZ, messageId: "wamid.late", customer, at: lateAt, type: "text", text: "an older reply, delivered late" });
    expect(rec.status).toBe("recorded");
    const applied = await applyPendingTakeovers(BIZ, id, `wa:${customer}`);
    expect(applied).toEqual({ applied: 1, tookOver: false });

    // 5. durably processed exactly once, as history_only
    const signals = (await listTakeoverSignals(BIZ, id)).filter((x) => x.messageId === "wamid.late");
    expect(signals).toHaveLength(1);
    expect(signals[0].applied?.outcome).toBe("history_only");
    expect(await applyPendingTakeovers(BIZ, id, `wa:${customer}`)).toEqual({ applied: 0, tookOver: false });

    expect(Date.parse(lateAt)).toBeLessThan(Date.parse(iso(t0)));

    // 6. the message is in the transcript (read back FROM THE STORE) as the person's, in time order, exactly once
    const final = (await store.get(id))!;
    const late = final.messages.filter((m) => m.content === "an older reply, delivered late");
    expect(late).toEqual([{ role: "owner", content: "an older reply, delivered late", at: lateAt, author: TEAM_MEMBER }]);
    expect(final.messages.map((m) => m.at)).toEqual([...final.messages.map((m) => m.at)].sort());
    // …and nothing else was duplicated by the save.
    expect(final.messages.map((m) => m.content)).toEqual(["Can I book tomorrow?", "Sure — what time?", "Hi! I'll check tomorrow for you.", "an older reply, delivered late"].sort((a, b) => final.messages.find((m) => m.content === a)!.at.localeCompare(final.messages.find((m) => m.content === b)!.at)));
    expect(final.messages).toHaveLength(4);

    // 7. holder stays BARRY;  8. no additional takeover transition
    expect(readControl(final).holder).toBe("barry");
    expect(readControlLog(final).filter((e) => e.to === "human").length).toBe(takeoversBefore);
  });
});
