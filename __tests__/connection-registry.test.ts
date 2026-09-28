import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildPersonalTrainerGraph } from "@/lib/fixtures/personal-trainer";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { handleCustomerMessage, handlePaymentWebhook } from "@/lib/runtime";
import { compile } from "@/lib/runtime/compiler";
import { getBackend } from "@/lib/store";
import { setPaymentAdapterForTests } from "@/lib/payments/capability";
import { setSchedulingAdapterForTests } from "@/lib/scheduling/capability";
import { registerPaymentAdapterFactoryForTests, resolvePaymentAdapterForBusiness } from "@/lib/payments/registry";
import { resolvePaymentAdapterForWebhook } from "@/lib/payments/registry";
import { resolveSchedulingAdapterForBusiness } from "@/lib/scheduling/registry";
import { PayPlusPaymentAdapter } from "@/lib/payments/adapters/payplus";
import { resolveCredentials } from "@/lib/connections/credentials";
import { resolveConnection } from "@/lib/connections/registry";
import type { CreatePaymentLinkInput, PaymentAdapter, ProviderPayment, VerifiedPaymentWebhook } from "@/lib/payments/adapters/types";

class RecordingPaymentAdapter implements PaymentAdapter {
  readonly payments = new Map<string, ProviderPayment>();
  created = 0;
  private readonly prefix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  constructor(readonly name: "stripe" | "payplus" | "memory") {}

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<ProviderPayment> {
    this.created += 1;
    const payment: ProviderPayment = {
      provider: this.name,
      providerPaymentId: `${this.name}_payment_${this.prefix}_${this.created}`,
      checkoutUrl: `https://${this.name}.example.test/checkout/${this.created}`,
      status: "pending",
      createdAt: new Date().toISOString(),
      idempotencyKey: input.idempotencyKey,
    };
    this.payments.set(payment.providerPaymentId, payment);
    return payment;
  }

  async getPaymentStatus(providerPaymentId: string): Promise<ProviderPayment | undefined> {
    return this.payments.get(providerPaymentId);
  }

  async verifyWebhook(rawBody: string): Promise<VerifiedPaymentWebhook> {
    const parsed = JSON.parse(rawBody) as {
      eventId: string;
      providerPaymentId: string;
      conversationId?: string;
      status: "paid" | "failed" | "cancelled";
    };
    return {
      provider: this.name,
      providerEventId: parsed.eventId,
      providerPaymentId: parsed.providerPaymentId,
      status: parsed.status,
      conversationId: parsed.conversationId,
      verifiedAt: new Date().toISOString(),
    };
  }
}

function payPlusSignature(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

afterEach(() => {
  setPaymentAdapterForTests(undefined);
  setSchedulingAdapterForTests(undefined);
  registerPaymentAdapterFactoryForTests("stripe", undefined);
  registerPaymentAdapterFactoryForTests("payplus", undefined);
  delete process.env.BARRY_REQUIRE_BUSINESS_CONNECTIONS;
  delete process.env.STRIPE_BUSINESS_A_SECRET_KEY;
  delete process.env.STRIPE_BUSINESS_A_WEBHOOK_SECRET;
  delete process.env.STRIPE_BUSINESS_B_SECRET_KEY;
  delete process.env.STRIPE_BUSINESS_B_WEBHOOK_SECRET;
});

describe("per-business connection registry", () => {
  it("resolves Stripe for Business A and PayPlus for Business B without global provider leakage", async () => {
    const backend = getBackend();
    await backend.upsertBusinessConnection({
      businessId: "business-a",
      capability: "payments",
      provider: "stripe",
      status: "connected",
      config: {},
      credentialsRef: "env:stripe",
      permissions: ["createPaymentLink", "verifyWebhook"],
    });
    await backend.upsertBusinessConnection({
      businessId: "business-b",
      capability: "payments",
      provider: "payplus",
      status: "connected",
      config: { environment: "staging" },
      credentialsRef: "env:payplus",
      permissions: ["createPaymentLink", "verifyWebhook"],
    });

    const stripeConnection = await resolveConnection("business-a", "payments");
    const payPlusConnection = await resolveConnection("business-b", "payments");

    expect(stripeConnection.provider).toBe("stripe");
    expect(payPlusConnection.provider).toBe("payplus");
  });

  it("uses the same createPaymentRequest runtime action for Stripe and PayPlus businesses", async () => {
    const stripeAdapter = new RecordingPaymentAdapter("stripe");
    const payPlusAdapter = new RecordingPaymentAdapter("payplus");
    registerPaymentAdapterFactoryForTests("stripe", () => stripeAdapter);
    registerPaymentAdapterFactoryForTests("payplus", () => payPlusAdapter);

    const backend = getBackend();
    await backend.upsertBusinessConnection({
      businessId: "spa",
      capability: "payments",
      provider: "stripe",
      status: "connected",
      config: {},
      credentialsRef: "env:stripe",
      permissions: ["createPaymentLink"],
    });
    await backend.upsertBusinessConnection({
      businessId: "personal-trainer",
      capability: "payments",
      provider: "payplus",
      status: "connected",
      config: {},
      credentialsRef: "env:payplus",
      permissions: ["createPaymentLink"],
    });

    const spa = buildSpaGraph();
    const trainer = buildPersonalTrainerGraph();
    const spaConv = `stripe-flow-${Date.now()}`;
    const trainerConv = `payplus-flow-${Date.now()}`;
    await handleCustomerMessage(spa, spaConv, "cust-stripe", "Couples massage Tuesday at 3pm");
    await handleCustomerMessage(spa, spaConv, "cust-stripe", "My name is Inon and my phone is 0501234567");
    const spaPayment = await handleCustomerMessage(spa, spaConv, "cust-stripe", "Yes");
    await handleCustomerMessage(trainer, trainerConv, "cust-payplus", "1:1 Training Session Tuesday at 7am");
    await handleCustomerMessage(trainer, trainerConv, "cust-payplus", "My name is Inon and my email is inon@example.com");
    const trainerPayment = await handleCustomerMessage(trainer, trainerConv, "cust-payplus", "Yes");

    expect(spaPayment.turn.selectedAction?.name).toBe("createPaymentRequest");
    expect(trainerPayment.turn.selectedAction?.name).toBe("createPaymentRequest");

    expect(stripeAdapter.created).toBe(1);
    expect(payPlusAdapter.created).toBe(1);
  });

  it("fails safely when a required connection is missing, disconnected, or errored", async () => {
    process.env.BARRY_REQUIRE_BUSINESS_CONNECTIONS = "1";
    await expect(resolvePaymentAdapterForBusiness("missing-business")).rejects.toThrow(/connection/i);

    const backend = getBackend();
    await backend.upsertBusinessConnection({
      businessId: "bad-business",
      capability: "payments",
      provider: "stripe",
      status: "error",
      config: {},
      credentialsRef: "env:stripe",
      permissions: [],
    });
    await expect(resolvePaymentAdapterForBusiness("bad-business")).rejects.toThrow(/not connected/i);

    await backend.upsertBusinessConnection({
      businessId: "disconnected-business",
      capability: "payments",
      provider: "payplus",
      status: "disconnected",
      config: {},
      credentialsRef: "env:payplus",
      permissions: [],
    });
    await expect(resolvePaymentAdapterForBusiness("disconnected-business")).rejects.toThrow(/not connected/i);
  });

  it("keeps provider-specific branches out of the compiler", () => {
    const source = compile.toString();
    expect(source).not.toMatch(/stripe|payplus|google-calendar/i);
  });

  it("resolves Google Calendar scheduling through the per-business connection", async () => {
    await getBackend().upsertBusinessConnection({
      businessId: "google-scheduling-business",
      capability: "scheduling",
      provider: "google-calendar",
      status: "connected",
      config: { calendarId: "calendar@example.com" },
      credentialsRef: "env:google-calendar",
      permissions: ["checkAvailability", "createBooking"],
    });

    const adapter = await resolveSchedulingAdapterForBusiness("google-scheduling-business");

    expect(adapter.name).toBe("google-calendar");
  });

  it("uses credentialsRef to resolve distinct credential sets for two businesses on the same provider", () => {
    process.env.STRIPE_BUSINESS_A_SECRET_KEY = "sk_a";
    process.env.STRIPE_BUSINESS_A_WEBHOOK_SECRET = "whsec_a";
    process.env.STRIPE_BUSINESS_B_SECRET_KEY = "sk_b";
    process.env.STRIPE_BUSINESS_B_WEBHOOK_SECRET = "whsec_b";

    const businessA = resolveCredentials("env:stripe:business-a", "stripe");
    const businessB = resolveCredentials("env:stripe:business-b", "stripe");

    expect(businessA.secretKey).toBe("sk_a");
    expect(businessA.webhookSecret).toBe("whsec_a");
    expect(businessB.secretKey).toBe("sk_b");
    expect(businessB.webhookSecret).toBe("whsec_b");
  });
});

describe("PayPlus adapter", () => {
  it("normalizes payment link creation to the BARRY payment contract", async () => {
    const adapter = new PayPlusPaymentAdapter({
      apiKey: "api",
      secretKey: "secret",
      paymentPageUid: "page",
      environment: "staging",
      callbackUrl: "https://barry.test/api/payments/webhook",
      successUrl: "https://barry.test/success",
      failureUrl: "https://barry.test/failure",
      cancelUrl: "https://barry.test/cancel",
      fetcher: (async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe("https://restapidev.payplus.co.il/api/v1.0/PaymentPages/generateLink");
        expect(new Headers(init?.headers).get("api-key")).toBe("api");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.payment_page_uid).toBe("page");
        expect(body.more_info).toBe("idem-payplus");
        return Response.json({
          results: { status: "success", code: 0 },
          data: {
            page_request_uid: "ppr_123",
            payment_page_link: "https://payplus.test/ppr_123",
          },
        });
      }) as typeof fetch,
    });

    const payment = await adapter.createPaymentLink({
      graph: buildSpaGraph(),
      businessId: "spa",
      conversationId: "conv-payplus",
      customerId: "cust-payplus",
      amount: 50,
      currency: "ILS",
      reason: "Deposit",
      idempotencyKey: "idem-payplus",
    });

    expect(payment).toMatchObject({
      provider: "payplus",
      providerPaymentId: "ppr_123",
      checkoutUrl: "https://payplus.test/ppr_123",
      status: "pending",
      idempotencyKey: "idem-payplus",
    });
  });

  it("routes PayPlus webhooks by more_info_1 before falling back to idempotency key parsing", async () => {
    const routedBusinessIds: string[] = [];
    registerPaymentAdapterFactoryForTests("payplus", (connection) => {
      routedBusinessIds.push(connection.businessId);
      return new RecordingPaymentAdapter("payplus");
    });
    await getBackend().upsertBusinessConnection({
      businessId: "payplus-business-a",
      capability: "payments",
      provider: "payplus",
      status: "connected",
      config: {},
      credentialsRef: "env:payplus:a",
      permissions: ["verifyWebhook"],
    });

    const body = JSON.stringify({
      more_info_1: "payplus-business-a",
      more_info: "legacy-business-id:conv:cust:50.00:ILS:Deposit",
    });
    await resolvePaymentAdapterForWebhook(body, { "user-agent": "PayPlus", hash: "hash" });

    expect(routedBusinessIds).toEqual(["payplus-business-a"]);
  });

  it("fails PayPlus webhook routing when more_info_1 points at the wrong business", async () => {
    process.env.BARRY_REQUIRE_BUSINESS_CONNECTIONS = "1";
    const body = JSON.stringify({
      more_info_1: "unknown-payplus-business",
      more_info: "spa:conv:cust:50.00:ILS:Deposit",
    });

    await expect(
      resolvePaymentAdapterForWebhook(body, { "user-agent": "PayPlus", hash: "hash" })
    ).rejects.toThrow(/connection/i);
  });

  it("rejects a PayPlus callback unless provider transaction verification succeeds", async () => {
    const body = JSON.stringify({ payment_request_uid: "ppr_123", transaction_uid: "txn_123", more_info: "idem-payplus" });
    const adapter = new PayPlusPaymentAdapter({
      apiKey: "api",
      secretKey: "secret",
      paymentPageUid: "page",
      fetcher: (async () => Response.json({ results: { status: "success" }, data: { transactions: [] } })) as typeof fetch,
    });

    await expect(
      adapter.verifyWebhook(body, { "user-agent": "PayPlus", hash: payPlusSignature(body, "secret") })
    ).rejects.toThrow(/verification/i);
  });

  it("uses documented transaction_uid lookup for PayPlus getPaymentStatus", async () => {
    const calls: Record<string, unknown>[] = [];
    const adapter = new PayPlusPaymentAdapter({
      apiKey: "api",
      secretKey: "secret",
      paymentPageUid: "page",
      fetcher: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          results: { status: "success" },
          data: { transactions: [{ transaction_uid: "txn_123", status: "success", more_info: "idem" }] },
        });
      }) as typeof fetch,
    });

    const status = await adapter.getPaymentStatus("txn_123");

    expect(calls).toEqual([{ transaction_uid: "txn_123" }]);
    expect(status?.status).toBe("paid");
  });

  it.each([
    ["amount", { amount: 49, currency_code: "ILS" }],
    ["currency", { amount: 50, currency_code: "USD" }],
  ])("rejects PayPlus callback with %s mismatch", async (_label, transaction) => {
    const body = JSON.stringify({
      payment_request_uid: "ppr_123",
      transaction_uid: "txn_123",
      more_info: "idem-payplus",
      amount: 50,
      currency_code: "ILS",
    });
    const adapter = new PayPlusPaymentAdapter({
      apiKey: "api",
      secretKey: "secret",
      paymentPageUid: "page",
      fetcher: (async () =>
        Response.json({
          results: { status: "success" },
          data: { transactions: [{ transaction_uid: "txn_123", status: "success", ...transaction }] },
        })) as typeof fetch,
    });

    await expect(
      adapter.verifyWebhook(body, { "user-agent": "PayPlus", hash: payPlusSignature(body, "secret") })
    ).rejects.toThrow(/mismatch/i);
  });

  it("duplicate verified PayPlus callback does not duplicate booking", async () => {
    const adapter = new RecordingPaymentAdapter("payplus");
    registerPaymentAdapterFactoryForTests("payplus", () => adapter);
    const backend = getBackend();
    await backend.upsertBusinessConnection({
      businessId: "spa",
      capability: "payments",
      provider: "payplus",
      status: "connected",
      config: {},
      credentialsRef: "env:payplus",
      permissions: ["createPaymentLink", "verifyWebhook"],
    });
    const graph = buildSpaGraph();
    const conv = `payplus-dup-${Date.now()}`;
    await handleCustomerMessage(graph, conv, "cust-payplus-dup", "Couples massage Tuesday at 3pm. My name is Inon and my phone is 0501234567");
    await handleCustomerMessage(graph, conv, "cust-payplus-dup", "Yes");
    const payment = (await backend.listPaymentRequests(graph.business.id)).find((p) => p.conversationId === conv)!;

    const callback = JSON.stringify({
      provider: "payplus",
      eventId: "evt_payplus_dup",
      providerPaymentId: payment.providerPaymentId,
      conversationId: conv,
      status: "paid",
    });
    await handlePaymentWebhook(callback, {});
    await handlePaymentWebhook(callback, {});

    expect((await backend.listBookings(graph.business.id)).filter((b) => b.conversationId === conv)).toHaveLength(1);
  });

  it("rejects PayPlus callback with the wrong conversation correlation", async () => {
    const adapter = new RecordingPaymentAdapter("payplus");
    registerPaymentAdapterFactoryForTests("payplus", () => adapter);
    const backend = getBackend();
    await backend.upsertBusinessConnection({
      businessId: "spa",
      capability: "payments",
      provider: "payplus",
      status: "connected",
      config: {},
      credentialsRef: "env:payplus",
      permissions: ["createPaymentLink", "verifyWebhook"],
    });
    const graph = buildSpaGraph();
    const conv = `payplus-wrong-conv-${Date.now()}`;
    await handleCustomerMessage(graph, conv, "cust-payplus-wrong", "Couples massage Tuesday at 3pm. My name is Inon and my phone is 0501234567");
    await handleCustomerMessage(graph, conv, "cust-payplus-wrong", "Yes");
    const payment = (await backend.listPaymentRequests(graph.business.id)).find((p) => p.conversationId === conv)!;

    const callback = JSON.stringify({
      provider: "payplus",
      eventId: "evt_payplus_wrong_conv",
      providerPaymentId: payment.providerPaymentId,
      conversationId: "different-conversation",
      status: "paid",
    });

    await expect(handlePaymentWebhook(callback, {})).rejects.toThrow(/conversation/i);
  });
});
