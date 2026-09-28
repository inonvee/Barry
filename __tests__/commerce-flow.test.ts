import { afterEach, describe, expect, it } from "vitest";
import { handleCustomerMessage, handlePaymentWebhook } from "@/lib/runtime";
import { buildFashionRetailerGraph } from "@/lib/fixtures/fashion-retailer";
import { getBackend } from "@/lib/store";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { MemoryPaymentAdapter, signedMemoryWebhook } from "@/lib/payments/adapters/memory";

afterEach(() => {
  setPaymentAdapterForTests(undefined);
});

describe("commerce operator flow", () => {
  it("finds a grounded black dress under budget, adds size M, creates checkout, and waits for verified payment", async () => {
    setPaymentAdapterForTests(new MemoryPaymentAdapter());
    const graph = buildFashionRetailerGraph();
    const conv = `commerce-black-dress-${Date.now()}`;
    const cust = `cust-${Date.now()}`;

    const search = await handleCustomerMessage(graph, conv, cust, "I need a black dress for a wedding, size M, under ₪450");
    expect(search.turn.selectedAction?.name).toBe("searchProducts");
    expect(search.response).toMatch(/Midnight Wrap Dress/i);
    expect(search.response).not.toMatch(/silk|runs small|flattering/i);

    const added = await handleCustomerMessage(graph, conv, cust, "Take the first one in M");
    expect(added.turn.selectedAction?.name).toBe("addToCart");
    expect(added.response).toMatch(/Midnight Wrap Dress/i);

    const checkout = await handleCustomerMessage(graph, conv, cust, "Checkout please");
    expect(checkout.turn.selectedAction?.name).toBe("createCommerceCheckout");
    expect(checkout.state.stage).toBe("payment");

    const claim = await handleCustomerMessage(graph, conv, cust, "I paid");
    expect(claim.turn.selectedAction?.name).not.toBe("createCommerceOrder");
    expect(claim.state.outcome).not.toBe("won");

    const payment = (await getBackend().listPaymentRequests(graph.business.id)).find((p) => p.conversationId === conv)!;
    const webhook = signedMemoryWebhook({
      eventId: `evt_commerce_${Date.now()}`,
      providerPaymentId: payment.providerPaymentId!,
      conversationId: conv,
      status: "paid",
    });
    const paid = await handlePaymentWebhook(webhook.body, webhook.headers);
    const duplicate = await handlePaymentWebhook(webhook.body, webhook.headers);

    expect(paid.result?.turn.selectedAction?.name).toBe("createCommerceOrder");
    expect(paid.result?.state.outcome).toBe("won");
    expect(duplicate.duplicate).toBe(true);
    expect((await getBackend().listCommerceOrders(graph.business.id)).filter((o) => o.conversationId === conv)).toHaveLength(1);
  });

  it("handles out-of-stock variants with a valid alternative and size changes", async () => {
    const graph = buildFashionRetailerGraph();
    const conv = `commerce-alt-${Date.now()}`;
    const cust = `cust-${Date.now()}`;

    await handleCustomerMessage(graph, conv, cust, "I need a black dress for a wedding, size S under 450 shekels");
    const out = await handleCustomerMessage(graph, conv, cust, "Take the first one in S");
    expect(out.turn.selectedAction?.name).toBe("addToCart");
    expect(out.response).toMatch(/not available|alternative/i);

    const changed = await handleCustomerMessage(graph, conv, cust, "Actually make it M");
    expect(changed.turn.selectedAction?.name).toBe("updateCartLine");
    expect(changed.response).toMatch(/M/i);
  });

  it("answers policy/order questions only from grounded commerce data", async () => {
    const graph = buildFashionRetailerGraph();
    const conv = `commerce-facts-${Date.now()}`;
    const cust = `cust-${Date.now()}`;

    const returns = await handleCustomerMessage(graph, conv, cust, "Can I return sale items?");
    expect(returns.response).toMatch(/14 days/i);
    expect(returns.response).toMatch(/sale items/i);
    expect(returns.response).not.toMatch(/lifetime|free returns/i);
  });
});
