import { afterEach, describe, expect, it } from "vitest";
import { handleCustomerMessage, handlePaymentWebhook } from "@/lib/runtime";
import { buildFashionRetailerGraph } from "@/lib/fixtures/fashion-retailer";
import { getBackend } from "@/lib/store";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { MemoryPaymentAdapter, signedMemoryWebhook } from "@/lib/payments/adapters/memory";
import {
  CommerceNotConfiguredError,
  registerCommerceAdapterFactoryForTests,
  resolveCommerceAdapterForBusiness,
} from "@/lib/commerce/registry";
import { cartSnapshotHash, createCommerceOrder } from "@/lib/commerce/capability";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { fashionCatalog } from "@/lib/fixtures/fashion-retailer";

const MARKDOWN = /\*\*|!\[|\]\(|^#+\s/m;

function ids() {
  const n = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return { conv: `hard-${n}`, cust: `cust-${n}` };
}

afterEach(() => {
  setPaymentAdapterForTests(undefined);
  delete process.env.BARRY_REQUIRE_BUSINESS_CONNECTIONS;
});

describe("Rina Studio regression (Hebrew, grounded selection)", () => {
  it("first grounded black dress in M enters the provider cart; 'אקח' never becomes a name; no markdown", async () => {
    const graph = buildFashionRetailerGraph();
    expect(graph.business.name).toBe("Rina Studio");
    const { conv, cust } = ids();

    const search = await handleCustomerMessage(graph, conv, cust, "אני צריכה שמלה שחורה לחתונה");
    expect(search.turn.selectedAction?.name).toBe("searchProducts");
    expect(search.response).not.toMatch(MARKDOWN);
    expect(search.rich?.products?.length).toBeGreaterThan(0);
    const firstTitle = search.rich!.products![0].title;

    const take = await handleCustomerMessage(graph, conv, cust, "יאללה אני אקח את הראשונה ב-M");
    expect(take.turn.selectedAction?.name).toBe("addToCart");
    expect(take.turn.toolResult?.ok).toBe(true);
    expect(take.turn.toolResult?.output).toMatchObject({ added: true });
    expect(take.state.knownFields.name).toBeUndefined();
    expect(take.response).not.toMatch(MARKDOWN);

    const cartId = take.state.knownFields.__commerceCartId;
    const adapter = await resolveCommerceAdapterForBusiness(graph.business.id);
    const cart = await adapter.getCart(cartId);
    expect(cart?.lines).toHaveLength(1);
    expect(cart?.lines[0].title).toBe(firstTitle);
    expect(cart?.lines[0].options.size).toBe("M");
  });

  it("product search replies are plain text; product cards and links travel in the rich payload only", async () => {
    const graph = buildFashionRetailerGraph();
    const { conv, cust } = ids();
    const search = await handleCustomerMessage(graph, conv, cust, "I need a black dress for a wedding, size M, under ₪450");
    expect(search.response).not.toMatch(MARKDOWN);
    expect(search.response).not.toMatch(/https?:\/\//);
    expect(search.rich?.products?.[0]).toMatchObject({ title: "Midnight Wrap Dress", price: "420 ILS" });
    expect(search.rich?.products?.[0].url).toMatch(/^https:\/\//);
    const stored = search.state.messages[search.state.messages.length - 1];
    expect(stored.rich?.products?.[0].title).toBe("Midnight Wrap Dress");
  });
});

describe("failed cart actions never advance the conversation", () => {
  it("an unknown option adds nothing and leaves the stage where it was", async () => {
    const graph = buildFashionRetailerGraph();
    const { conv, cust } = ids();
    const search = await handleCustomerMessage(graph, conv, cust, "I need a black dress for a wedding");
    const before = search.state.stage;
    const take = await handleCustomerMessage(graph, conv, cust, "Take the first one in XXL");
    expect(take.turn.selectedAction?.name).toBe("addToCart");
    expect(take.turn.toolResult?.output).toMatchObject({ added: false });
    expect(take.state.stage).toBe(before);
    expect(take.state.knownFields.__commerceCartId).toBeUndefined();
    expect(take.state.knownFields.__paymentRequestId).toBeUndefined();
    expect(take.response).not.toMatch(/added/i);
  });

  it("a reference to a result that was never shown asks which item instead of guessing", async () => {
    const graph = buildFashionRetailerGraph();
    const { conv, cust } = ids();
    const take = await handleCustomerMessage(graph, conv, cust, "I'll take the first one in M");
    expect(take.turn.selectedAction ?? undefined).toBeUndefined();
    expect(take.response).toMatch(/which|what are you looking for/i);
    expect(take.state.knownFields.__commerceCartId).toBeUndefined();
  });
});

describe("payment is bound to the cart snapshot", () => {
  async function toCheckout() {
    const paymentAdapter = new MemoryPaymentAdapter();
    setPaymentAdapterForTests(paymentAdapter);
    const graph = buildFashionRetailerGraph();
    const { conv, cust } = ids();
    await handleCustomerMessage(graph, conv, cust, "I need a black dress for a wedding, size M, under ₪450");
    await handleCustomerMessage(graph, conv, cust, "Take the first one in M");
    const checkout = await handleCustomerMessage(graph, conv, cust, "My name is Dana and my phone is 0501234567");
    expect(checkout.turn.selectedAction?.name).toBe("createCommerceCheckout");
    const paymentId = checkout.state.knownFields.__paymentRequestId;
    const payment = (await getBackend().getPaymentRequest(paymentId))!;
    return { graph, conv, cust, paymentAdapter, checkout, payment };
  }

  it("the payment record carries the exact snapshot it was priced from", async () => {
    const { graph, checkout, payment } = await toCheckout();
    const adapter = await resolveCommerceAdapterForBusiness(graph.business.id);
    const cart = (await adapter.getCart(checkout.state.knownFields.__commerceCartId))!;
    expect(payment.binding).toEqual({
      kind: "commerce_cart",
      cartId: cart.id,
      snapshotHash: cartSnapshotHash(cart),
      amount: cart.total.amount,
      currency: cart.total.currency,
    });
    expect(payment.amount).toBe(cart.total.amount);
    expect(checkout.rich?.paymentUrl).toMatch(/^https:\/\//);
    expect(checkout.response).not.toMatch(/https?:\/\//);
  });

  it("changing the cart after checkout cancels the unpaid payment; consent for the old cart does not carry to the new one", async () => {
    const { graph, conv, cust, payment } = await toCheckout();
    const changed = await handleCustomerMessage(graph, conv, cust, "Actually make it L");
    // The customer's change runs; the old checkout (priced for the old cart) is cancelled, and no new
    // checkout is created on consent that was given for a different cart revision.
    expect(changed.turn.trace?.steps.map((st) => [st.action, st.trigger])).toEqual([["updateCartLine", "customer"]]);
    expect((await getBackend().getPaymentRequest(payment.id))?.status).toBe("cancelled");
    expect(changed.state.knownFields.__paymentRequestId).toBeUndefined();
    expect(changed.state.knownFields.__commerceCheckoutRequested).toBeUndefined();
    const adapter = await resolveCommerceAdapterForBusiness(graph.business.id);
    const cart = (await adapter.getCart(changed.state.knownFields.__commerceCartId))!;
    expect(cart.lines.map((l) => l.options.size)).toEqual(["L"]);
    // Explicit consent for the new cart re-issues checkout bound to the new snapshot.
    const again = await handleCustomerMessage(graph, conv, cust, "ok checkout now");
    const fresh = (await getBackend().getPaymentRequest(again.state.knownFields.__paymentRequestId))!;
    expect(fresh.id).not.toBe(payment.id);
    expect(fresh.binding?.snapshotHash).toBe(cartSnapshotHash((await adapter.getCart(again.state.knownFields.__commerceCartId))!));
  });

  it("a verified payment for a superseded payment request never creates an order", async () => {
    const { graph, conv, cust, payment } = await toCheckout();
    await handleCustomerMessage(graph, conv, cust, "Actually make it L");
    const webhook = signedMemoryWebhook({
      eventId: `evt_superseded_${Date.now()}`,
      providerPaymentId: payment.providerPaymentId!,
      conversationId: conv,
      status: "paid",
    });
    const result = await handlePaymentWebhook(webhook.body, webhook.headers);
    expect(result.superseded).toBe(true);
    expect(result.result).toBeUndefined();
    expect((await getBackend().listCommerceOrders(graph.business.id)).filter((o) => o.conversationId === conv)).toHaveLength(0);
  });

  it("order creation re-verifies the provider cart against the paid snapshot", async () => {
    const { graph, conv, cust, payment } = await toCheckout();
    await getBackend().updatePaymentRequestStatus(payment.id, "paid", { verifiedAt: new Date().toISOString() });
    // The cart is changed on the provider behind BARRY's back.
    const adapter = await resolveCommerceAdapterForBusiness(graph.business.id);
    const cart = (await adapter.getCart(payment.binding!.cartId))!;
    await adapter.updateQuantity({ cartId: cart.id, lineId: cart.lines[0].id, quantity: 2 });

    await expect(
      createCommerceOrder({ graph, customerId: cust, conversationId: conv, cartId: cart.id, paymentRequestId: payment.id })
    ).rejects.toThrow(/Cart changed after payment/);
  });

  it("an unverified 'I paid' checks the provider: pending stays pending, provider-confirmed paid creates exactly one order", async () => {
    const { graph, conv, cust, paymentAdapter, payment } = await toCheckout();
    const claim = await handleCustomerMessage(graph, conv, cust, "I paid");
    expect(claim.turn.selectedAction?.name).toBe("verifyPayment");
    expect(claim.state.outcome).not.toBe("won");
    expect(claim.state.knownFields.__paid).toBeUndefined();

    // The provider now reports the payment as completed (webhook not yet delivered).
    paymentAdapter.payments.get(payment.providerPaymentId!)!.status = "paid";
    const again = await handleCustomerMessage(graph, conv, cust, "אחי שילמתי כבר");
    expect(again.turn.selectedAction?.name).toBe("createCommerceOrder");
    expect(again.state.outcome).toBe("won");

    // The webhook arriving afterwards is harmless.
    const webhook = signedMemoryWebhook({
      eventId: `evt_late_${Date.now()}`,
      providerPaymentId: payment.providerPaymentId!,
      conversationId: conv,
      status: "paid",
    });
    await handlePaymentWebhook(webhook.body, webhook.headers).catch(() => undefined);
    expect((await getBackend().listCommerceOrders(graph.business.id)).filter((o) => o.conversationId === conv)).toHaveLength(1);
  });
});

describe("commerce registry fails closed", () => {
  it("a business with no commerce connection and no registered fixture gets an error, not someone else's catalog", async () => {
    await expect(resolveCommerceAdapterForBusiness(`no-commerce-${Date.now()}`)).rejects.toThrow(/commerce/i);
  });

  it("a custom-commerce connection without credentials is an error, never a fixture fallback", async () => {
    const businessId = `custom-no-creds-${Date.now()}`;
    await getBackend().upsertBusinessConnection({
      businessId,
      capability: "commerce",
      provider: "custom-commerce",
      status: "connected",
      config: { baseUrl: "https://shop.example.test" },
      credentialsRef: "env:custom-commerce:missing",
      permissions: ["searchProducts"],
    });
    await expect(resolveCommerceAdapterForBusiness(businessId)).rejects.toBeInstanceOf(CommerceNotConfiguredError);
  });

  it("a memory connection must name its fixture catalog explicitly", async () => {
    const businessId = `memory-unnamed-${Date.now()}`;
    await getBackend().upsertBusinessConnection({
      businessId,
      capability: "commerce",
      provider: "memory",
      status: "connected",
      config: {},
      credentialsRef: "env:memory",
      permissions: ["searchProducts"],
    });
    await expect(resolveCommerceAdapterForBusiness(businessId)).rejects.toBeInstanceOf(CommerceNotConfiguredError);
  });

  it("fixture catalogs are refused in a production runtime unless explicitly allowed", async () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV, BARRY_ENV: process.env.BARRY_ENV };
    const businessId = `memory-prod-${Date.now()}`;
    await getBackend().upsertBusinessConnection({
      businessId,
      capability: "commerce",
      provider: "memory",
      status: "connected",
      config: { fixtureCatalog: "fashion-retailer" },
      credentialsRef: "env:memory",
      permissions: ["searchProducts"],
    });
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      process.env.VERCEL_ENV = "production";
      await expect(resolveCommerceAdapterForBusiness(businessId)).rejects.toThrow(/disabled in production/);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = saved.NODE_ENV;
      if (saved.VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = saved.VERCEL_ENV;
    }
  });

  it("a test factory is honoured exactly (used for provider-executed cart tests)", async () => {
    const businessId = `factory-${Date.now()}`;
    const adapter = new MemoryCommerceAdapter(fashionCatalog());
    registerCommerceAdapterFactoryForTests(businessId, () => adapter);
    try {
      expect(await resolveCommerceAdapterForBusiness(businessId)).toBe(adapter);
    } finally {
      registerCommerceAdapterFactoryForTests(businessId, undefined);
    }
  });
});
