import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PAID-PILOT P0 PHASE 3.5 — FAIL CLOSED WITHOUT THE CONCURRENCY GUARD.
 *
 * A fake Supabase client answers exactly like a database WITHOUT migration 0019 ("function not found",
 * "relation does not exist"). Every conversation write path must refuse — nothing written, nothing sent,
 * no model call — and say why. There is no unprotected last-write-wins fallback any more.
 */

type Call = { kind: "rpc" | "from"; name: string; op?: string; args?: unknown };
const calls: Call[] = [];
let rpcAnswer: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown } = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.barry_save_conversation" } });
let tableAnswer: (table: string, op: string) => { data: unknown; error: unknown } = (table) => ({ data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } });

function builder(table: string) {
  let op = "select";
  const b: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "upsert", "delete", "eq", "in", "order", "limit", "maybeSingle", "single", "like", "lt"]) {
    b[m] = (...args: unknown[]) => {
      if (["insert", "update", "upsert", "delete"].includes(m)) {
        op = m;
        calls.push({ kind: "from", name: table, op: m, args: args[0] });
      }
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) => resolve(tableAnswer(table, op));
  return b;
}

vi.mock("@/lib/store/supabase-client", () => ({
  isSupabaseConfigured: () => false,
  getSupabaseClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ kind: "rpc", name, args });
      return rpcAnswer(name, args);
    },
    from: (table: string) => builder(table),
  }),
}));

import { SupabaseConversationStore, ConversationConflictError, createInitialConversationState } from "@/lib/state";
import { ConcurrencyGuardMissingError, SupabaseLockStore, setLockStoreForTests, withConversationLock } from "@/lib/state/lock";
import { SupabaseInboxStore, setInboxStoreForTests } from "@/lib/channels/inbox";
import { processInbound, type OutboundSender } from "@/lib/channels/gateway";
import { handleCustomerMessage } from "@/lib/runtime";
import { setReasonerForTests } from "@/lib/reasoner";
import { getConversationStore } from "@/lib/state";
import { ownerFailure } from "@/lib/owner/http";
import { getBusinessGraph } from "@/lib/fixtures";
import { ScriptedModel } from "./support/scripted-model";

const writes = () => calls.filter((c) => c.kind === "from" && c.op !== "select");

beforeEach(() => {
  calls.length = 0;
  rpcAnswer = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
  tableAnswer = (table) => ({ data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } });
});
afterEach(() => {
  setLockStoreForTests(undefined);
  setInboxStoreForTests(undefined);
  setReasonerForTests(undefined);
});

describe("the Supabase conversation store without migration 0019", () => {
  it("refuses to save (no atomic save function) — and writes NOTHING through any other path", async () => {
    const store = new SupabaseConversationStore();
    const state = { ...createInitialConversationState("c1", "b1", "u1"), version: 0 };
    state.knownFields.handoff = "open";
    await expect(store.save(state)).rejects.toBeInstanceOf(ConcurrencyGuardMissingError);
    expect(calls.filter((c) => c.kind === "rpc").map((c) => c.name)).toEqual(["barry_save_conversation"]);
    expect(writes()).toEqual([]);
  });

  it("refuses to save a copy read without a version (a pre-0019 row) — before touching the database", async () => {
    const store = new SupabaseConversationStore();
    const state = createInitialConversationState("c1", "b1", "u1");
    await expect(store.save(state)).rejects.toThrow(/migration 0019/);
    expect(calls).toEqual([]);
  });

  it("with the guard installed: a stale copy is refused (conflict), a current one gets the new version", async () => {
    const store = new SupabaseConversationStore();
    rpcAnswer = (_n, args) => ({ data: args.p_expected_version === 3 ? 4 : null, error: null });
    const stale = { ...createInitialConversationState("c1", "b1", "u1"), version: 2 };
    await expect(store.save(stale)).rejects.toBeInstanceOf(ConversationConflictError);
    const current = { ...createInitialConversationState("c1", "b1", "u1"), version: 3 };
    current.messages.push({ role: "customer", content: "hi", at: "2026-10-03T10:00:00.000Z" });
    await store.save(current);
    expect(current.version).toBe(4);
    const call = calls.filter((c) => c.kind === "rpc").at(-1)!.args as Record<string, unknown>;
    expect(call).toMatchObject({ p_id: "c1", p_expected_version: 3, p_messages: [{ role: "customer", content: "hi" }] });
    expect(writes()).toEqual([]);
  });
});

describe("conversation locks and the inbox without migration 0019", () => {
  it("the lock refuses (no in-process fallback): the turn never runs, the model is never called", async () => {
    setLockStoreForTests(new SupabaseLockStore());
    const model = new ScriptedModel(() => undefined);
    setReasonerForTests(model);
    await expect(withConversationLock("c1", async () => "ran")).rejects.toBeInstanceOf(ConcurrencyGuardMissingError);
    await expect(handleCustomerMessage(getBusinessGraph("fashion-retailer"), "conv-guard-1", "u1", "hello")).rejects.toBeInstanceOf(ConcurrencyGuardMissingError);
    expect(model.calls).toBe(0);
    expect(await getConversationStore().get("conv-guard-1")).toBeUndefined();
  });

  it("the inbox refuses: an inbound WhatsApp message is not processed and nothing is sent (the provider retries later)", async () => {
    setInboxStoreForTests(new SupabaseInboxStore());
    const model = new ScriptedModel(() => undefined);
    setReasonerForTests(model);
    const sent: string[] = [];
    const sender: OutboundSender = { channel: "whatsapp", mode: "live", send: async (_to, text) => (sent.push(text), {}) };
    const msg = { businessId: "fashion-retailer", conversationId: "wa:fashion-retailer:972500000555", customerId: "wa:972500000555", identity: { channel: "whatsapp" as const, channelUserId: "972500000555", verifiedIdentifier: "phone:972500000555" }, text: "hi", receivedAt: new Date().toISOString(), inboundId: "wamid.guard.1" };
    await expect(processInbound(msg, sender)).rejects.toBeInstanceOf(ConcurrencyGuardMissingError);
    expect(model.calls).toBe(0);
    expect(sent).toEqual([]);
    expect(await getConversationStore().get(msg.conversationId)).toBeUndefined();
  });

  it("the WhatsApp webhook answers 'retry' for it (Meta re-delivers once the guard is installed)", async () => {
    setInboxStoreForTests(new SupabaseInboxStore());
    const out = await processInbound({ businessId: "fashion-retailer", conversationId: "wa:fashion-retailer:972500000556", customerId: "wa:972500000556", identity: { channel: "whatsapp", channelUserId: "972500000556" }, text: "x", receivedAt: new Date().toISOString(), inboundId: "wamid.guard.2" }, { channel: "whatsapp", mode: "dry_run", send: async () => ({}) }).catch((err) => ({ status: "failed" as const, retry: true, err }));
    expect(out).toMatchObject({ status: "failed", retry: true });
  });

  it("a stage write can't move an inbox row backwards (CAS in the real store's query)", async () => {
    const inbox = new SupabaseInboxStore();
    tableAnswer = () => ({ data: [], error: null }); // no row matched "id = … and status = 'processing'"
    await expect(inbox.update("b:whatsapp:m1", { status: "failed" }, "processing")).rejects.toThrow(/another request moved it/);
  });
});

describe("the operational error is said plainly", () => {
  it("owner APIs answer 503 with a code — nothing changed, the BARRY team must act", async () => {
    const res = ownerFailure("handoff", new ConcurrencyGuardMissingError("test"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "concurrency_guard_missing" });
  });
});
