import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import "@/lib/fabric";
import { handleCustomerMessage, handlePaymentOutcome } from "@/lib/runtime";
import { setReasonerForTests } from "@/lib/reasoner";
import { getBackend } from "@/lib/store";
import { getOwnerWorkspace } from "@/lib/owner/service";
import { askOwnerBarry } from "@/lib/owner/ask";
import { isOpen } from "@/lib/operator/obligations";
import { NextExpectedAction, WatchingList } from "@/components/owner/operating";
import { resetControlsCacheForTests } from "@/lib/hq/controls";
import { ScriptedModel, conv, isolatedRetailer } from "./support/scripted-model";

/**
 * CHECKPOINT 3 — the proactive operator in the OWNER product: the same obligations drive Today ("BARRY is
 * watching"), the conversation's next expected action, Money's unpaid follow-ups and the Ask BARRY
 * briefing; they complete with evidence and disappear from the open lists. Deterministic, not live proof.
 */

let dispose: (() => void) | undefined;
afterEach(() => {
  setReasonerForTests(undefined);
  resetControlsCacheForTests();
  dispose?.();
  dispose = undefined;
});

const who = { customerInfo: { name: "Adi", phone: "0505550114" }, evidence: { "customerInfo.name": "Adi", "customerInfo.phone": "0505550114" } };

describe("an unpaid link is watched, shown everywhere from one model, and completed by the provider's verification", () => {
  it("Today / conversation / Money / Ask BARRY agree, then the obligation completes with the payment record as evidence", async () => {
    const r = isolatedRetailer();
    dispose = r.dispose;
    const model = new ScriptedModel(() => undefined);
    setReasonerForTests(model);
    const id = conv("watch");
    model.plan = () => ({ commerce: { intent: "search", query: { text: "midnight" } }, advancesTransaction: true });
    await handleCustomerMessage(r.g, id, "c", "the midnight dress");
    model.plan = () => ({ commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }, purchaseDecision: false, advancesTransaction: true });
    await handleCustomerMessage(r.g, id, "c", "add it in M");
    model.plan = () => ({ commerce: { intent: "checkout" }, checkoutConsent: true, advancesTransaction: true, ...who });
    const pay = await handleCustomerMessage(r.g, id, "c", "checkout, Adi 0505550114");
    const paymentRequestId = pay.state.knownFields.__paymentRequestId;
    expect(paymentRequestId).toBeTruthy();

    const ws = await getOwnerWorkspace(r.g);
    const ob = ws.obligations.find((o) => o.conversationId === id)!;
    expect(ob).toMatchObject({ kind: "unpaid_payment_followup", status: "waiting_on_customer", nextMove: "waiting_on_customer", customer: "Adi", amount: 420, currency: "ILS", simulated: true });
    expect(ob.evidence[0]).toMatch(/payment request .* pending/);

    // Today: the watching list (owner words, whose move, next action).
    const list = renderToString(createElement(WatchingList, { items: ws.obligations, onOpen: () => undefined }));
    expect(list).toMatch(/Waiting on the customer/);
    expect(list).toMatch(/Adi: 420 ILS payment link/);
    expect(list).toMatch(/Next: Wait for the customer to pay/);
    expect(list).toMatch(/>test</);
    // Conversation: the next expected action.
    const next = renderToString(createElement(NextExpectedAction, { items: ws.obligations, conversationId: id }));
    expect(next).toMatch(/Next expected action/);
    expect(next).toMatch(/Wait for the customer to pay/);
    // Ask BARRY: the briefing carries it, from the same records.
    const ask = await askOwnerBarry(r.g, "What are you watching?");
    expect(ask.briefing.watching).toEqual([expect.objectContaining({ customer: "Adi", kind: "unpaid payment followup", whoseMove: "Waiting on the customer", amount: "₪420", simulated: true })]);
    expect(ask.answer).toMatch(/BARRY is watching: Adi: 420 ILS payment link/);

    // The provider verifies the payment: the obligation completes with evidence and leaves every open list.
    await getBackend().simulatePaymentOutcome(paymentRequestId, "paid");
    await handlePaymentOutcome(r.g, id, paymentRequestId, "paid");
    const after = await getOwnerWorkspace(r.g);
    const done = after.obligations.find((o) => o.key === ob.key)!;
    expect(done).toMatchObject({ status: "completed", completion: { evidence: expect.stringMatching(/verified paid/) } });
    expect(after.obligations.filter(isOpen).some((o) => o.conversationId === id)).toBe(false);
    expect(renderToString(createElement(WatchingList, { items: after.obligations }))).toMatch(/Nothing to watch/);
    expect(renderToString(createElement(NextExpectedAction, { items: after.obligations, conversationId: id }))).toBe("");
    expect((await askOwnerBarry(r.g, "What are you watching?")).briefing.watching).toEqual([]);
  });
});
