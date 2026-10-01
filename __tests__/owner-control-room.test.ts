import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import "@/lib/fabric";
import { handleCustomerMessage, handlePaymentOutcome } from "@/lib/runtime";
import { setReasonerForTests } from "@/lib/reasoner";
import { getBackend } from "@/lib/store";
import { getOwnerWorkspace, ownerChannels, type OwnerWorkspace } from "@/lib/owner/service";
import { activityFeed, nowWorking, workflows } from "@/lib/owner/control-room";
import { resetControlsCacheForTests } from "@/lib/hq/controls";
import { TodayView } from "@/components/owner/views/Today";
import { MoneyView } from "@/components/owner/views/Money";
import { ActionsView } from "@/components/owner/views/Actions";
import { WhatsAppCard } from "@/components/owner/OwnerShell";
import { Flow } from "@/components/owner/kit";
import { conversationState } from "@/components/owner/views/shared";
import type { Obligation } from "@/lib/operator/obligation-model";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * THE OWNER CONTROL ROOM: the "BARRY is working" lines, the live activity feed and the
 * COMMAND → BARRY → OUTCOME workflows render ONLY recorded state; money counts as recovered only when the
 * provider verified the payment after BARRY followed up, and test money is never money. The WhatsApp
 * owner channel is shown as not connected (it isn't built). The views render from a real workspace.
 */

let dispose: (() => void) | undefined;
afterEach(() => {
  setReasonerForTests(undefined);
  resetControlsCacheForTests();
  dispose?.();
  dispose = undefined;
});

const who = { customerInfo: { name: "Adi", phone: "0505550114" }, evidence: { "customerInfo.name": "Adi", "customerInfo.phone": "0505550114" } };
const noop = () => undefined;

async function pendingPayment() {
  const r = isolatedRetailer();
  dispose = r.dispose;
  const model = new ScriptedModel(() => undefined);
  setReasonerForTests(model);
  const id = conv("room");
  model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
  await handleCustomerMessage(r.g, id, "c", "the midnight dress");
  model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true });
  await handleCustomerMessage(r.g, id, "c", "add it in M");
  model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, ...who });
  const pay = await handleCustomerMessage(r.g, id, "c", "checkout, Adi 0505550114");
  return { ...r, id, paymentRequestId: pay.state.knownFields.__paymentRequestId };
}

const ob = (o: Partial<Obligation>): Obligation =>
  ({ key: `k:${Math.random()}`, businessId: "b", kind: "unpaid_payment_followup", source: "s", evidence: [], conversationId: "c1", customer: "Dana", subject: "₪420 payment link", reason: "r", desiredOutcome: "d", nextAction: "n", nextMove: "waiting_on_customer", owner: "customer", eligibleAt: "2026-10-01T00:00:00.000Z", status: "waiting_on_customer", authority: "none", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", amount: 420, currency: "ILS", ...o }) as Obligation;

describe("control-room read model: only recorded work, honest outcomes", () => {
  it("workflows count eligible / contacted / open / closed; recovered only = verified paid AFTER a follow-up; test money never counts", () => {
    const obligations = [
      ob({ status: "completed", attempts: 1, completion: { at: "2026-10-01T10:00:00.000Z", evidence: "payment request pay_1 verified paid" } }),
      ob({ status: "completed", attempts: 0, completion: { at: "2026-10-01T11:00:00.000Z", evidence: "payment request pay_2 verified paid" } }),
      ob({ status: "waiting_on_customer", attempts: 1, amount: 300 }),
      ob({ status: "cancelled", cancellation: { at: "2026-10-01T12:00:00.000Z", reason: "withdrawn" } }),
      ob({ status: "completed", attempts: 1, simulated: true, completion: { at: "2026-10-01T10:00:00.000Z", evidence: "payment request pay_3 verified paid" } }),
      ob({ kind: "abandoned_checkout_recovery", status: "completed", attempts: 1, completion: { at: "2026-10-01T10:00:00.000Z", evidence: "payment request pay_9 created after the recovery (pending)" } }),
    ];
    const [unpaid, abandoned] = workflows({ obligations });
    expect(unpaid).toMatchObject({ command: "Follow up unpaid payment links", commandBy: "Your follow-up rule", eligible: 5, contacted: 3, open: 1, excluded: 1, closed: 3, closedLabel: "Paid (verified)", recovered: { ILS: 420 }, atStake: { ILS: 300 }, testItems: 1 });
    // An abandoned checkout "closes" when the customer came back to checkout — never as money.
    expect(abandoned).toMatchObject({ closedLabel: "Came back to checkout", closed: 1, recovered: {} });
    expect(workflows({ obligations: [] })).toEqual([]);
  });

  it("'BARRY is working' and the feed come from open obligations and records; an empty business shows nothing invented", () => {
    const lines = nowWorking({ obligations: [ob({ nextMove: "barry_can_act", status: "actionable" }), ob({ nextMove: "barry_can_act", status: "actionable", conversationId: "c2" }), ob({ conversationId: "c3" })], interventions: [] });
    expect(lines.map((l) => l.text)).toEqual(["Following up 2 unpaid payment links", "Waiting on 1 customer"]);
    expect(nowWorking({ obligations: [], interventions: [] })).toEqual([]);
    expect(activityFeed({ outcomes: [], approvals: [], obligations: [], conversations: [] })).toEqual([]);
  });

  it("conversation states are the five the owner scans for", () => {
    const row = (status: string, attention: string[] = []) => ({ status, attention }) as unknown as Parameters<typeof conversationState>[0];
    expect(conversationState(row("in_progress"))).toBe("barry");
    expect(conversationState(row("waiting_on_customer"))).toBe("customer");
    expect(conversationState(row("needs_you", ["approval_waiting"]))).toBe("you");
    expect(conversationState(row("needs_you", ["action_failed"]))).toBe("review");
    expect(conversationState(row("completed"))).toBe("resolved");
  });
});

describe("the control room renders from a real workspace", () => {
  it("Today shows the live work, the feed and the rule → result flow; after verification the payment appears as confirmed, test money is labelled", async () => {
    const { g, id, paymentRequestId } = await pendingPayment();
    let ws = await getOwnerWorkspace(g);
    const today = renderToString(createElement(TodayView, { ws, act: noop, busyId: null, loading: false, onOpen: noop, onIntervention: noop, onTab: noop }));
    expect(today).toMatch(/BARRY is working/);
    expect(today).toMatch(/Waiting on 1 customer/);
    expect(today).toMatch(/From your rules to real results/);
    expect(today).toMatch(/Follow up unpaid payment links/);
    await getBackend().simulatePaymentOutcome(paymentRequestId, "paid");
    await handlePaymentOutcome(g, id, paymentRequestId, "paid");
    ws = await getOwnerWorkspace(g);
    const feed = activityFeed(ws);
    expect(feed[0].text).toBe("Order created — Adi"); // newest first: the order follows the verified payment
    const paid = feed.find((f) => f.text === "Payment confirmed — Adi")!;
    expect(paid).toMatchObject({ icon: "money", tone: "ok" });
    expect(paid.sub).toMatch(/verified by the payment provider · test/);
    expect(feed.some((f) => f.text === "Closed — Adi")).toBe(true);
    const money = renderToString(createElement(MoneyView, { ws, range: "today", setRange: noop, onOpen: noop, onIntervention: noop, loadedAt: null }));
    expect(money).toMatch(/Nothing collected/); // simulated money is never "made"
    expect(money).toMatch(/Test money/);
  });

  it("Actions renders the queue; the owner WhatsApp channel is never shown as connected when it isn't", async () => {
    const { g } = await pendingPayment();
    const ws: OwnerWorkspace = await getOwnerWorkspace(g);
    expect(ws.channels).toEqual(ownerChannels(g.business.id));
    expect(ws.channels.ownerCommands).toBe("not_connected");
    const actions = renderToString(createElement(ActionsView, { ws, act: noop, busyId: null, onOpen: noop }));
    expect(actions).toMatch(/Nothing needs you right now/);
    const card = renderToString(createElement(WhatsAppCard, { channels: ws.channels }));
    expect(card).toMatch(/Owner commands: not connected yet/);
    expect(card).toMatch(/Ask BARRY here/);
    expect(card).not.toMatch(/Open BARRY in WhatsApp/);
  });

  it("the Flow primitive renders command, work and verified result as given", () => {
    const html = renderToString(createElement(Flow, { command: "Follow up unpaid payment links", commandBy: "Your follow-up rule", work: [{ label: "Contacted", value: 9 }], outcome: [{ label: "Paid (verified)", value: 2, tone: "ok" }] }));
    expect(html).toMatch(/Your follow-up rule/);
    expect(html).toMatch(/BARRY works/);
    expect(html).toMatch(/Verified result/);
    expect(html).toMatch(/Paid \(verified\)/);
  });
});
