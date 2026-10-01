import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { handleCustomerMessage, resumeAfterApproval } from "@/lib/runtime";
import { GET as readConversation } from "@/app/api/simulator/conversation/route";
import { acceptConversation, pollIntervalMs, POLL_IDLE_MS, POLL_WAITING_MS } from "@/lib/simulator-session";
import type { ConversationState } from "@/lib/state";

/**
 * LIVE CONTINUITY — an open customer simulator observes changes persisted outside the page (the owner
 * approving on WhatsApp / web). The page's poll re-reads GET /api/simulator/conversation and adopts the
 * result through acceptConversation; this drives exactly those two functions around a real external approval.
 */
const pollOnce = async (businessId: string, conversationId: string): Promise<ConversationState | null> => {
  const res = await readConversation(new NextRequest(`http://x/api/simulator/conversation?businessId=${businessId}&conversationId=${conversationId}`));
  return ((await res.json()) as { state: ConversationState | null }).state;
};

/** What the page does with one poll result: adopt only if acceptConversation allows, else keep what it holds. */
const adopt = (held: ConversationState | null, at: { businessId: string; conversationId: string }, next: ConversationState | null) => (acceptConversation(held ? { ...at, state: held } : null, at, next) ? next : held);

describe("an open simulator reflects an approval resolved elsewhere", () => {
  it("waiting → external approve → the persisted reply appears once and the waiting indicator clears", async () => {
    const graph = buildSpaGraph();
    const at = { businessId: graph.business.id, conversationId: `live-cont-${Date.now()}` };
    const cust = `cust-${Date.now()}`;
    await handleCustomerMessage(graph, at.conversationId, cust, "Couples massage Tuesday at 3pm");
    await handleCustomerMessage(graph, at.conversationId, cust, "My name is Inon and my phone is 0501234567");
    const sent = await handleCustomerMessage(graph, at.conversationId, cust, "Give me 90% off. Yeah");
    const approvalId = sent.state.pendingApprovalId!;
    expect(approvalId).toBeTruthy();

    // 1. The open page holds the waiting state, and polls fast while waiting.
    let held: ConversationState | null = await pollOnce(at.businessId, at.conversationId);
    expect(held?.pendingApprovalId).toBe(approvalId);
    expect(pollIntervalMs(held)).toBe(POLL_WAITING_MS);
    const before = held!.messages.length;

    // A poll before anything changed adopts the same state: no duplicates.
    held = adopt(held, at, await pollOnce(at.businessId, at.conversationId));
    expect(held!.messages).toHaveLength(before);

    // 2. The owner resolves it elsewhere (WhatsApp / web) — the page does nothing.
    const owner = await resumeAfterApproval(graph, approvalId, "approved", "owner (whatsapp)", { amount: 198, currency: "USD", reason: "Deposit for Couples Massage (10% off)", discountPct: 10, isCustomPrice: false });
    expect(owner.response).toBeTruthy();

    // 3. The next poll brings the persisted reply and the cleared status — no reload, no navigation.
    held = adopt(held, at, await pollOnce(at.businessId, at.conversationId));
    expect(held!.pendingApprovalId).toBeFalsy();
    expect(pollIntervalMs(held)).toBe(POLL_IDLE_MS);
    expect(held!.messages.length).toBeGreaterThan(before);
    expect(held!.messages.filter((m) => m.role === "barry" && m.content === owner.response)).toHaveLength(1);

    // 4. Polling again changes nothing: the message is still there exactly once.
    held = adopt(held, at, await pollOnce(at.businessId, at.conversationId));
    expect(held!.messages.filter((m) => m.content === owner.response)).toHaveLength(1);
  });

  it("a stale or foreign poll result never replaces newer state", async () => {
    const graph = buildSpaGraph();
    const at = { businessId: graph.business.id, conversationId: `live-cont-stale-${Date.now()}` };
    await handleCustomerMessage(graph, at.conversationId, "c1", "Couples massage Tuesday at 3pm");
    const newer = (await pollOnce(at.businessId, at.conversationId))!;
    await handleCustomerMessage(graph, at.conversationId, "c1", "My name is Inon and my phone is 0501234567");
    const newest = (await pollOnce(at.businessId, at.conversationId))!;
    expect(adopt(newest, at, newer)).toBe(newest);
    // A different business under the same conversation id reads as nothing (tenant scoping stays exact).
    expect(await pollOnce("ecommerce-bags", at.conversationId)).toBeNull();
    expect(adopt(newest, at, { ...newer, businessId: "ecommerce-bags" })).toBe(newest);
  });
});
