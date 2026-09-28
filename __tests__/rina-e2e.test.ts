import { afterEach, describe, expect, it } from "vitest";
import { handleCustomerMessage } from "@/lib/runtime";
import { buildFashionRetailerGraph, fashionCatalog } from "@/lib/fixtures/fashion-retailer";
import { setReasonerForTests, type BarryIR } from "@/lib/reasoner";
import { registerCommerceAdapterFactoryForTests } from "@/lib/commerce/registry";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { MemoryPaymentAdapter } from "@/lib/payments/adapters/memory";
import { getBackend } from "@/lib/store";
import { ScriptedReasoner } from "./support/semantic-corpus";

/**
 * The Rina Studio acceptance flow, end to end through the real runtime
 * (compiler, capability gate, policy, memory providers, operator loop,
 * deterministic composer). The model is SCRIPTED with what a competent model
 * emits — this proves the runtime, not a live model.
 *
 * Rina's playbook requires name + phone before checkout. The customer gives
 * them in two separate messages; the phone message is digits only.
 */

const SEARCH = "היי אני מחפשת שמלה במידה מדיום עד 400 ש״ח";
const TAKE = "אני אקח אותה במדיום";
const NAME = "שירה לוי";
const PHONE = "0558832177";
const PAID = "שילמתי";
const IN_L = "יש אותה ב-L?";

const SCRIPT: Record<string, Partial<BarryIR>> = {
  [SEARCH]: { intent: "search", commerce: { intent: "search", query: { text: SEARCH, category: "dress", budget: { amount: 400, currency: "ILS" } }, variant: { size: "M" } } },
  [TAKE]: { intent: "select", purchaseDecision: true, commerce: { intent: "select", variant: { size: "M" } } },
  [NAME]: { intent: "details", customerInfo: { name: NAME }, evidence: { "customerInfo.name": NAME } },
  [PHONE]: { intent: "details", customerInfo: { phone: PHONE }, evidence: { "customerInfo.phone": PHONE } },
  [PAID]: { intent: "payment_claim", customerClaims: { paymentCompleted: true } },
  [IN_L]: { intent: "inquire", purchaseDecision: false, commerce: { intent: "inquire", variant: { size: "L" } } },
};

const ASKS_TO_CONTINUE = /רוצה להמשיך|להמשיך לתשלום\?|would you like to continue|shall i continue/i;
const ASKS_NAME = /(^|[^\p{L}])(ה|ו|ש)?שם(?![\p{L}])/u;

let id = "";
let payments: MemoryPaymentAdapter;
let commerce: MemoryCommerceAdapter;
function rina() {
  id = `rina-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  commerce = new MemoryCommerceAdapter(fashionCatalog());
  registerCommerceAdapterFactoryForTests(id, () => commerce);
  payments = new MemoryPaymentAdapter();
  setPaymentAdapterForTests(payments);
  setReasonerForTests(new ScriptedReasoner(SCRIPT));
  const base = buildFashionRetailerGraph();
  return { ...base, business: { ...base.business, id } };
}

afterEach(() => {
  registerCommerceAdapterFactoryForTests(id, undefined);
  setPaymentAdapterForTests(undefined);
  setReasonerForTests(undefined);
});

describe("Rina E2E: search → take → name → phone → checkout → payment claim", () => {
  it("runs the whole flow in Hebrew, asks only for what is missing, and never orders before the provider says paid", async () => {
    const g = rina();
    const conv = `conv-${id}`;
    const say = (m: string) => handleCustomerMessage(g, conv, "c", m);

    const search = await say(SEARCH);
    expect(search.rich?.products?.map((p) => p.title)).toEqual(["Onyx Slip Dress"]);

    // Decision: Onyx M goes into a real provider cart; BARRY asks for exactly name + phone.
    const take = await say(TAKE);
    expect(take.turn.trace?.steps.map((s) => [s.action, s.result?.ok])).toEqual([["addToCart", true]]);
    expect(take.turn.trace?.stop).toEqual({ reason: "needs_customer", outcome: "checkout_needs_info" });
    expect(take.state.missingFields).toEqual(["name", "phone"]);
    expect(take.turn.trace?.context?.shown).toEqual([{ position: 1, title: "Onyx Slip Dress" }]);
    const cart = await commerce.getCart(take.state.knownFields.__commerceCartId);
    expect(cart?.lines.map((l) => [l.title, l.options.size])).toEqual([["Onyx Slip Dress", "M"]]);
    expect(take.response).toMatch(ASKS_NAME);
    expect(take.response).toMatch(/טלפון/);
    expect(take.response).not.toMatch(/שם מלא|full name/i);

    // Name accepted; only the phone is still missing — the name is not asked again.
    const name = await say(NAME);
    expect(name.turn.verification?.customerFacts).toEqual([expect.objectContaining({ field: "name", status: "accepted" })]);
    expect(name.state.knownFields.name).toBe(NAME);
    expect(name.state.missingFields).toEqual(["phone"]);
    expect(name.response).toMatch(/טלפון/);
    expect(name.response).not.toMatch(ASKS_NAME);
    expect(name.turn.trace?.reply).toMatchObject({ language: "he", basis: "current_turn" });

    // Digits only: accepted, language stays Hebrew, checkout runs automatically.
    const phone = await say(PHONE);
    expect(phone.turn.verification?.customerFacts).toEqual([expect.objectContaining({ field: "phone", status: "accepted" })]);
    expect(phone.turn.trace?.reply).toMatchObject({ language: "he", basis: "recent_turn" });
    expect(phone.turn.trace?.steps.map((s) => [s.action, s.result?.ok])).toEqual([["createCommerceCheckout", true]]);
    expect(phone.state.missingFields).toEqual([]);
    expect(phone.rich?.paymentUrl).toMatch(/^https:\/\//);
    expect(phone.state.knownFields.__paid).toBeUndefined();
    expect(phone.response).toMatch(/[א-ת]/);
    expect(phone.response).not.toMatch(ASKS_NAME);
    for (const out of [take, name, phone]) expect(out.response).not.toMatch(ASKS_TO_CONTINUE);

    // "I paid" while the provider says pending: verify only — no order, no "paid".
    const pending = await say(PAID);
    expect(pending.turn.trace?.steps.map((s) => s.action)).toEqual(["verifyPayment"]);
    expect(pending.state.knownFields.__paid).toBeUndefined();
    expect(pending.state.knownFields.__commerceOrderId).toBeUndefined();
    expect((await getBackend().listCommerceOrders(id)).filter((o) => o.conversationId === conv)).toHaveLength(0);
    expect(pending.response).toMatch(/[א-ת]/);

    // The provider now reports paid: verify, then exactly one order.
    const request = (await getBackend().getPaymentRequest(phone.state.knownFields.__paymentRequestId))!;
    payments.payments.get(request.providerPaymentId!)!.status = "paid";
    const paid = await say(PAID);
    expect(paid.turn.trace?.steps.map((s) => [s.action, s.trigger, s.result?.ok])).toEqual([
      ["verifyPayment", "customer", true],
      ["createCommerceOrder", "continuation", true],
    ]);
    expect(paid.state.outcome).toBe("won");
    expect((await getBackend().listCommerceOrders(id)).filter((o) => o.conversationId === conv)).toHaveLength(1);

    // Claiming again never creates a second order.
    const again = await say(PAID);
    expect(again.turn.trace?.steps.map((s) => s.action) ?? []).not.toContain("createCommerceOrder");
    expect((await getBackend().listCommerceOrders(id)).filter((o) => o.conversationId === conv)).toHaveLength(1);
  });

  it("an availability question about the shown dress answers about stock — no cart change, no checkout", async () => {
    const g = rina();
    const conv = `conv-${id}`;
    await handleCustomerMessage(g, conv, "c", SEARCH);
    const q = await handleCustomerMessage(g, conv, "c", IN_L);
    expect(q.turn.trace?.steps.map((s) => s.action) ?? []).not.toContain("addToCart");
    expect(q.turn.trace?.steps.map((s) => s.action) ?? []).not.toContain("createCommerceCheckout");
    expect(q.state.knownFields.__paymentRequestId).toBeUndefined();
    expect(q.state.knownFields.__commerceCartId).toBeUndefined();
    expect(q.turn.trace?.stop.outcome).toBe("product_info");
  });

  it("the payment claim before any checkout says there is nothing to verify — it never marks anything paid", async () => {
    const g = rina();
    const conv = `conv-${id}`;
    await handleCustomerMessage(g, conv, "c", SEARCH);
    const claim = await handleCustomerMessage(g, conv, "c", PAID);
    expect(claim.turn.trace?.steps ?? []).toEqual([]);
    expect(claim.turn.trace?.stop.outcome).toBe("no_payment_to_verify");
    expect(claim.state.knownFields.__paid).toBeUndefined();
  });
});
