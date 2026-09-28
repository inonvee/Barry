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

    // A decision, not a request to operate BARRY: it adds the item and moves
    // straight on toward checkout, asking only for what this business needs.
    const added = await handleCustomerMessage(graph, conv, cust, "Take the first one in M");
    expect(added.turn.selectedAction?.name).toBe("addToCart");
    expect(added.response).toMatch(/Midnight Wrap Dress/i);
    expect(added.turn.trace?.stop).toEqual({ reason: "needs_customer", outcome: "checkout_needs_info" });
    expect(added.response).toMatch(/name/i);
    expect(added.response).not.toMatch(/would you like|shall i continue|want me to/i);

    const checkout = await handleCustomerMessage(graph, conv, cust, "My name is Dana and my phone is 0501234567");
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
    // Never silently substituted: nothing enters the cart, the real
    // in-stock alternatives are offered, and the stage does not advance.
    expect(out.turn.toolResult?.output).toMatchObject({ added: false, notAdded: { reason: "unavailable" } });
    expect(out.response).toMatch(/isn't available in S/i);
    expect(out.response).toMatch(/M/);
    expect(out.state.knownFields.__commerceCartId).toBeUndefined();
    expect(out.state.stage).not.toBe("payment");

    // The customer picks a real alternative -> it enters the provider cart.
    const chosen = await handleCustomerMessage(graph, conv, cust, "Actually make it M");
    expect(chosen.turn.selectedAction?.name).toBe("addToCart");
    expect(chosen.turn.toolResult?.output).toMatchObject({ added: true });
    expect(chosen.state.knownFields.__commerceCartId).toBeTruthy();

    // A later size change edits that line ON THE PROVIDER.
    const changed = await handleCustomerMessage(graph, conv, cust, "Actually make it L");
    expect(changed.turn.selectedAction?.name).toBe("updateCartLine");
    expect(changed.turn.toolResult?.ok).toBe(true);
    expect(changed.response).toMatch(/L/);
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
