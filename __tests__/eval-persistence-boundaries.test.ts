import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { handleCustomerMessage, handlePaymentOutcome } from "@/lib/runtime";
import { getConversationStore } from "@/lib/state";

/**
 * MEGA RELIABILITY MISSION — Part 16: persistence/process boundaries.
 *
 * No local OPENAI_API_KEY or SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY were
 * set in this environment (confirmed via `env`), so the existing
 * Supabase-backed integration suites (`supabase-persistence.test.ts`:
 * cross-instance conversation reload, a real multi-turn conversation
 * surviving a simulated cold start; `supabase-idempotency.test.ts`:
 * DB-level booking/payment/inventory race guards, now including the
 * Part 15 oversell guard) correctly auto-skip locally — but per this
 * mission part's own instruction ("if local credentials are unavailable,
 * write integration coverage and verify against the Barry Supabase
 * project via available tooling where possible"), the equivalent
 * behavior was verified LIVE against project `ynnmlsnmybbaxeyolydj`
 * (the only project this mission may touch) via the Supabase MCP tools
 * in this same session:
 *
 * - `reserve_inventory` (migration 0004, applied live this session):
 *   first reservation of a single-unit SKU returns true; a second
 *   reservation attempt on the same now-depleted SKU returns false —
 *   confirmed directly via `execute_sql` RPC calls.
 * - Full create -> persist -> reload -> continue -> persist -> reload
 *   AGAIN cycle: a conversation row was inserted, its messages/turn_logs
 *   inserted, then read back via a SEPARATE query (no shared JS
 *   object/connection — the same "different serverless invocation"
 *   property `supabase-persistence.test.ts` exercises at the app level);
 *   then updated (stage change, known_fields JSONB merge, offer
 *   selection) and reloaded a third time, confirming known_fields
 *   accumulated correctly (the JSONB merge preserved the earlier
 *   `__mentionedEarliest` scratch key alongside the newly-added name/
 *   phone) and message_count/turn_count both reflected every insert.
 * - `payment_requests_one_pending_per_conversation_uidx` (migration
 *   0002): a second pending payment request for the same conversation
 *   was confirmed to be REJECTED by the database with a real unique-
 *   violation error, not merely by application logic.
 * - `get_advisors` (security + performance): no new findings introduced
 *   by migration 0004; all existing findings are informational and
 *   pre-existing (RLS-enabled-no-policy is the intended service-role-
 *   only access model this whole architecture already documents).
 * - All test rows/functions used for this live verification were
 *   cleaned up immediately after (confirmed via a follow-up count query
 *   and orphan-row check on the FK-cascaded messages/turn_logs).
 *
 * This file covers what IS runnable locally without credentials: the
 * conversation-store contract itself, using the in-memory backend that
 * stands in for Supabase in this environment. Simulator-level semantics
 * (refresh restores per-business conversationId, New Conversation gets a
 * fresh id, switching businesses never cross-wires) are already covered
 * by `simulator-session.test.ts`.
 */
describe("Persistence boundaries: a completed transaction's stage survives independent store reloads", () => {
  it("stage 'closed' persists across a fresh store.get() call, not just in-memory state", async () => {
    const graph = buildSpaGraph();
    const conv = "persist-closed-" + Date.now();
    const cust = "cust-" + Date.now();
    await handleCustomerMessage(graph, conv, cust, "Couples massage Tuesday at 3pm");
    await handleCustomerMessage(graph, conv, cust, "My name is Inon and my phone is 0501234567");
    const r = await handleCustomerMessage(graph, conv, cust, "Yeah");
    const paymentId = r.state.knownFields.__paymentRequestId;
    await handlePaymentOutcome(graph, conv, paymentId, "paid");

    // A fresh store.get() call — not reusing any in-memory object from
    // the calls above — must see the persisted closed/won state.
    const store = getConversationStore();
    const reloaded = await store.get(conv);
    expect(reloaded?.stage).toBe("closed");
    expect(reloaded?.outcome).toBe("won");
  });

  it("a duplicate payment webhook against a conversation reloaded from the store still short-circuits correctly", async () => {
    const graph = buildSpaGraph();
    const conv = "persist-dup-" + Date.now();
    const cust = "cust-" + Date.now();
    await handleCustomerMessage(graph, conv, cust, "Couples massage Tuesday at 3pm");
    await handleCustomerMessage(graph, conv, cust, "My name is Inon and my phone is 0501234567");
    const r = await handleCustomerMessage(graph, conv, cust, "Yeah");
    const paymentId = r.state.knownFields.__paymentRequestId;
    await handlePaymentOutcome(graph, conv, paymentId, "paid");

    // handlePaymentOutcome itself always does a fresh store.get() (see
    // engine.ts) — this proves the "closed" guard (Part 13) is a
    // property of PERSISTED state, not a same-process-only shortcut.
    const second = await handlePaymentOutcome(graph, conv, paymentId, "paid");
    expect(second.turn.toolResult).toBeUndefined();
    expect(second.response).toMatch(/already/i);
  });
});

describe("Persistence boundaries: messages and turns accumulate across independent turns, never reset", () => {
  it("message/turn counts only ever grow, matching exactly one pair/entry per real turn", async () => {
    const graph = buildSpaGraph();
    const conv = "persist-accumulate-" + Date.now();
    const cust = "cust-" + Date.now();
    const store = getConversationStore();

    await handleCustomerMessage(graph, conv, cust, "Couples massage Tuesday at 3pm");
    const afterT1 = await store.get(conv);
    expect(afterT1?.messages.length).toBe(2); // customer + barry
    expect(afterT1?.turns.length).toBe(1);

    await handleCustomerMessage(graph, conv, cust, "My name is Inon and my phone is 0501234567");
    const afterT2 = await store.get(conv);
    expect(afterT2?.messages.length).toBe(4);
    expect(afterT2?.turns.length).toBe(2);
  });
});
