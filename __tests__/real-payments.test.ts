import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { buildPersonalTrainerGraph } from "@/lib/fixtures/personal-trainer";
import { handleCustomerMessage, handlePaymentWebhook } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import { setSchedulingAdapterForTests } from "@/lib/scheduling/capability";
import { MemorySchedulingAdapter } from "@/lib/scheduling/adapters/memory";
import type { CheckAvailabilityInput, CreateBookingInput, SchedulingAdapter } from "@/lib/scheduling/adapters/types";
import {
  createPaymentLink,
  setPaymentAdapterForTests,
} from "@/lib/payments/capability";
import { MemoryPaymentAdapter, signedMemoryWebhook } from "@/lib/payments/adapters/memory";
import { StripePaymentAdapter } from "@/lib/payments/adapters/stripe";
import { enforceComposeGrounding } from "@/lib/reasoner/openai-reasoner";
import { POST as paymentWebhookPost } from "@/app/api/payments/webhook/route";
import { runScenario } from "./support/eval-harness";

afterEach(() => {
  setPaymentAdapterForTests(undefined);
  setSchedulingAdapterForTests(undefined);
});

function stripeSignature(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function stripeEventBody(input: {
  id: string;
  type: string;
  session: Record<string, unknown>;
}): string {
  return JSON.stringify({
    id: input.id,
    type: input.type,
    data: { object: input.session },
  });
}

describe("real payment capability", () => {
  it("creates one payment link and returns the existing one on retry", async () => {
    const adapter = new MemoryPaymentAdapter();
    setPaymentAdapterForTests(adapter);
    const graph = buildSpaGraph();
    const input = {
      graph,
      businessId: graph.business.id,
      conversationId: `pay-once-${Date.now()}`,
      customerId: "cust-pay-once",
      amount: 50,
      currency: "USD",
      reason: "Deposit for Couples Massage",
    };

    const first = await createPaymentLink(input);
    const retry = await createPaymentLink(input);

    expect(retry.paymentRequestId).toBe(first.paymentRequestId);
    expect(retry.providerPaymentId).toBe(first.providerPaymentId);
    expect(retry.checkoutUrl).toBe(first.checkoutUrl);
    expect(adapter.createdCount).toBe(1);
  });

  it("invalid webhook signatures do not mutate payment state", async () => {
    setPaymentAdapterForTests(new MemoryPaymentAdapter());
    const graph = buildSpaGraph();
    const payment = await createPaymentLink({
      graph,
      businessId: graph.business.id,
      conversationId: `pay-invalid-sig-${Date.now()}`,
      customerId: "cust-invalid-sig",
      amount: 50,
      currency: "USD",
      reason: "Deposit for Couples Massage",
    });

    const body = JSON.stringify({ eventId: "evt_bad", providerPaymentId: payment.providerPaymentId, status: "paid" });
    await expect(handlePaymentWebhook(body, { "x-barry-payment-signature": "bad" })).rejects.toThrow(/signature/i);

    const stored = await getBackend().getPaymentRequest(payment.paymentRequestId);
    expect(stored?.status).toBe("pending");
  });

  it("a verified success webhook marks paid, resumes runtime, and creates the booking once", async () => {
    setPaymentAdapterForTests(new MemoryPaymentAdapter());
    const graph = buildSpaGraph();
    const conv = `pay-success-${Date.now()}`;
    const cust = `cust-${Date.now()}`;

    await handleCustomerMessage(graph, conv, cust, "Couples massage Tuesday at 3pm");
    await handleCustomerMessage(graph, conv, cust, "My name is Inon and my phone is 0501234567");
    const requested = await handleCustomerMessage(graph, conv, cust, "Yes");
    expect(requested.turn.selectedAction?.name).toBe("createPaymentRequest");
    const paymentId = requested.state.knownFields.__paymentRequestId;
    const payment = await getBackend().getPaymentRequest(paymentId);
    expect(payment?.status).toBe("pending");

    const webhook = signedMemoryWebhook({
      eventId: `evt_success_${Date.now()}`,
      providerPaymentId: payment!.providerPaymentId!,
      conversationId: conv,
      status: "paid",
    });
    const completed = await handlePaymentWebhook(webhook.body, webhook.headers);

    expect(completed.result?.turn.selectedAction?.name).toBe("createBooking");
    expect(completed.result?.turn.toolResult?.ok).toBe(true);
    expect(completed.result?.state.stage).toBe("closed");
    expect(completed.result?.state.outcome).toBe("won");

    const duplicate = await handlePaymentWebhook(webhook.body, webhook.headers);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.result).toBeUndefined();
  });

  it("a webhook with the wrong conversation/payment pairing is rejected", async () => {
    setPaymentAdapterForTests(new MemoryPaymentAdapter());
    const graph = buildSpaGraph();
    const payment = await createPaymentLink({
      graph,
      businessId: graph.business.id,
      conversationId: `pay-wrong-${Date.now()}`,
      customerId: "cust-wrong",
      amount: 50,
      currency: "USD",
      reason: "Deposit for Couples Massage",
    });

    const webhook = signedMemoryWebhook({
      eventId: `evt_wrong_${Date.now()}`,
      providerPaymentId: payment.providerPaymentId,
      conversationId: "different-conversation",
      status: "paid",
    });

    await expect(handlePaymentWebhook(webhook.body, webhook.headers)).rejects.toThrow(/conversation/i);
    const stored = await getBackend().getPaymentRequest(payment.paymentRequestId);
    expect(stored?.status).toBe("pending");
  });

  it("failed payment can be retried with a fresh payment link", async () => {
    setPaymentAdapterForTests(new MemoryPaymentAdapter());
    const graph = buildSpaGraph();
    const conv = `pay-fail-retry-${Date.now()}`;
    const base = {
      graph,
      businessId: graph.business.id,
      conversationId: conv,
      customerId: "cust-fail-retry",
      amount: 50,
      currency: "USD",
      reason: "Deposit for Couples Massage",
    };
    const first = await createPaymentLink(base);
    const failed = signedMemoryWebhook({
      eventId: `evt_failed_${Date.now()}`,
      providerPaymentId: first.providerPaymentId,
      conversationId: conv,
      status: "failed",
    });
    await handlePaymentWebhook(failed.body, failed.headers);

    const retry = await createPaymentLink(base);
    expect(retry.paymentRequestId).not.toBe(first.paymentRequestId);
    expect(retry.providerPaymentId).not.toBe(first.providerPaymentId);
  });
});

describe("Stripe payment hardening", () => {
  it("creates sessions with a POST idempotency key and never uses unsupported client_reference_id list filtering", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const adapter = new StripePaymentAdapter({
      secretKey: "sk_test_fake",
      webhookSecret: "whsec_fake",
      fetcher: (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        expect(String(url)).not.toContain("/checkout/sessions?");
        expect(String(url)).not.toContain("client_reference_id=");
        return Response.json({
          id: "cs_test_123",
          url: "https://checkout.stripe.test/cs_test_123",
          status: "open",
          payment_status: "unpaid",
          created: 1_700_000_000,
        });
      }) as typeof fetch,
    });

    const payment = await adapter.createPaymentLink({
      graph: buildSpaGraph(),
      businessId: "serenity-massage-spa",
      conversationId: "conv-stripe-idempotent",
      customerId: "cust-stripe-idempotent",
      amount: 50,
      currency: "USD",
      reason: "Deposit",
      idempotencyKey: "idem-123",
    });

    expect(payment.providerPaymentId).toBe("cs_test_123");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(new Headers(calls[0].init?.headers).get("idempotency-key")).toBe("idem-123");
  });

  it.each([
    ["checkout.session.completed", "paid", "complete", "paid"],
    ["checkout.session.completed", "unpaid", "complete", "pending"],
    ["checkout.session.async_payment_succeeded", "paid", "complete", "paid"],
    ["checkout.session.async_payment_failed", "unpaid", "complete", "failed"],
    ["checkout.session.expired", "unpaid", "expired", "cancelled"],
  ] as const)("maps Stripe %s payment_status=%s status=%s to %s", async (type, paymentStatus, status, expected) => {
    const secret = "whsec_test";
    const body = stripeEventBody({
      id: `evt_${type.replace(/\W/g, "_")}_${paymentStatus}`,
      type,
      session: {
        id: "cs_status",
        status,
        payment_status: paymentStatus,
        metadata: { conversationId: "conv-status", idempotencyKey: "idem-status" },
      },
    });
    const adapter = new StripePaymentAdapter({ secretKey: "sk_test", webhookSecret: secret });

    const verified = await adapter.verifyWebhook(body, { "stripe-signature": stripeSignature(body, secret) });

    expect(verified.status).toBe(expected);
  });

  it("does not book when Stripe checkout completes before payment is paid", async () => {
    const secret = "whsec_test";
    const graph = buildSpaGraph();
    const conv = `stripe-unpaid-${Date.now()}`;
    const cust = `cust-${Date.now()}`;
    const adapter = new StripePaymentAdapter({
      secretKey: "sk_test",
      webhookSecret: secret,
      fetcher: (async () =>
        Response.json({
          id: "cs_unpaid_runtime",
          url: "https://checkout.stripe.test/cs_unpaid_runtime",
          status: "open",
          payment_status: "unpaid",
          created: 1_700_000_000,
        })) as typeof fetch,
    });
    setPaymentAdapterForTests(adapter);

    await handleCustomerMessage(graph, conv, cust, "Couples massage Tuesday at 3pm");
    await handleCustomerMessage(graph, conv, cust, "My name is Inon and my phone is 0501234567");
    const requested = await handleCustomerMessage(graph, conv, cust, "Yes");
    const paymentId = requested.state.knownFields.__paymentRequestId;
    expect(paymentId).toBeTruthy();

    const body = stripeEventBody({
      id: `evt_unpaid_${Date.now()}`,
      type: "checkout.session.completed",
      session: {
        id: "cs_unpaid_runtime",
        status: "complete",
        payment_status: "unpaid",
        metadata: { conversationId: conv, idempotencyKey: "unused" },
      },
    });
    const result = await handlePaymentWebhook(body, { "stripe-signature": stripeSignature(body, secret) });
    const payment = await getBackend().getPaymentRequest(paymentId);

    expect(result.payment?.status).toBe("pending");
    expect(result.result).toBeUndefined();
    expect(payment?.status).toBe("pending");
    expect((await getBackend().listBookings(graph.business.id)).filter((b) => b.conversationId === conv)).toHaveLength(0);
  });

  it("rejects stale Stripe webhook signatures by timestamp tolerance", async () => {
    const secret = "whsec_test";
    const body = stripeEventBody({
      id: "evt_stale",
      type: "checkout.session.completed",
      session: { id: "cs_stale", status: "complete", payment_status: "paid", metadata: {} },
    });
    const adapter = new StripePaymentAdapter({
      secretKey: "sk_test",
      webhookSecret: secret,
      now: () => 1_700_000_600_000,
      webhookToleranceSeconds: 300,
    });

    await expect(
      adapter.verifyWebhook(body, { "stripe-signature": stripeSignature(body, secret, 1_700_000_000) })
    ).rejects.toThrow(/signature/i);
  });

  it("webhook HTTP failures do not expose raw internal exception details", async () => {
    const response = await paymentWebhookPost(
      new NextRequest("https://barry.test/api/payments/webhook", {
        method: "POST",
        body: JSON.stringify({ invalid: true }),
        headers: { "stripe-signature": "bad" },
      })
    );
    const payload = (await response.json()) as { ok: boolean; error?: string };

    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("Payment webhook rejected");
  });
});

describe("payment webhook resume durability", () => {
  it("retries the same paid webhook after a failed booking resume and creates exactly one booking", async () => {
    setPaymentAdapterForTests(new MemoryPaymentAdapter());
    const backend = getBackend();
    const delegate = new MemorySchedulingAdapter(backend);
    let createAttempts = 0;
    const flakyScheduling: SchedulingAdapter = {
      name: "memory",
      checkAvailability(input: CheckAvailabilityInput) {
        return delegate.checkAvailability(input);
      },
      async createBooking(input: CreateBookingInput) {
        createAttempts += 1;
        if (createAttempts === 1) throw new Error("temporary booking outage");
        return delegate.createBooking(input);
      },
      getBooking(providerEventId: string) {
        return delegate.getBooking(providerEventId);
      },
    };
    setSchedulingAdapterForTests(flakyScheduling);

    const graph = buildSpaGraph();
    const conv = `pay-webhook-retry-${Date.now()}`;
    const cust = `cust-${Date.now()}`;
    await handleCustomerMessage(graph, conv, cust, "Couples massage Tuesday at 3pm");
    await handleCustomerMessage(graph, conv, cust, "My name is Inon and my phone is 0501234567");
    const requested = await handleCustomerMessage(graph, conv, cust, "Yes");
    const payment = await backend.getPaymentRequest(requested.state.knownFields.__paymentRequestId);
    expect(payment?.status).toBe("pending");

    const webhook = signedMemoryWebhook({
      eventId: `evt_retry_${Date.now()}`,
      providerPaymentId: payment!.providerPaymentId!,
      conversationId: conv,
      status: "paid",
    });
    await expect(handlePaymentWebhook(webhook.body, webhook.headers)).rejects.toThrow(/resume/i);

    const completed = await handlePaymentWebhook(webhook.body, webhook.headers);
    const bookings = await backend.listBookings(graph.business.id);

    expect(completed.duplicate).toBe(false);
    expect(completed.result?.turn.selectedAction?.name).toBe("createBooking");
    expect(completed.result?.state.outcome).toBe("won");
    expect(bookings.filter((b) => b.conversationId === conv)).toHaveLength(1);
  });
});

describe("transactional response grounding", () => {
  it("replaces invented customer-info requests after availability with deterministic slot confirmation", () => {
    const graph = buildPersonalTrainerGraph();
    const state = {
      id: "conv-grounding",
      businessId: graph.business.id,
      conversationId: "conv-grounding",
      customerId: "cust-grounding",
      stage: "scheduling" as const,
      selectedOfferId: "free-consultation",
      knownFields: { name: "Inon", email: "inon@example.com" },
      missingFields: [],
      objections: [],
      messages: [{ role: "customer" as const, content: "Thursday at 12pm", at: new Date().toISOString() }],
      turns: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const text = enforceComposeGrounding(
      "Great, please send your phone number before I can continue.",
      { graph, state, customerMessage: "Thursday at 12pm" },
      {
        outcome: {
          kind: "action",
          stage: "scheduling",
          action: { name: "checkAvailability", input: {} },
        },
        toolResult: { ok: true, output: { slots: [{ resourceId: "coach-riley", start: "2026-10-01T16:00:00.000Z", end: "2026-10-01T16:30:00.000Z" }] } },
        scheduling: { availableSlots: [{ localDate: "Thursday, October 1", localTime: "12:00 PM", timeZone: "America/New_York" }] },
      }
    );

    expect(text.toLowerCase()).not.toMatch(/phone|name|email/);
    expect(text).toContain("12:00 PM");
    expect(text).toMatch(/available|work/i);
  });
});

describe("payment flow guardrails", () => {
  it("customer saying they paid does not book before a verified webhook", async () => {
    setPaymentAdapterForTests(new MemoryPaymentAdapter());
    const { state, turns } = await runScenario({
      name: "real-payment-customer-claim",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage Tuesday at 3pm" },
        { customer: "My name is Inon and my phone is 0501234567" },
        { customer: "Yes" },
        { customer: "I paid, mark me paid" },
      ],
    });

    const last = turns.at(-1)!;
    expect(last.selectedAction?.name).not.toBe("createBooking");
    expect(state.stage).toBe("payment");
    expect(state.outcome).not.toBe("won");
  });

  it("booking cannot happen before verified payment for a paid scheduled offer", async () => {
    setPaymentAdapterForTests(new MemoryPaymentAdapter());
    const graph = buildSpaGraph();
    const conv = `pay-before-book-${Date.now()}`;
    const cust = `cust-${Date.now()}`;
    await handleCustomerMessage(graph, conv, cust, "Couples massage Tuesday at 3pm");
    await handleCustomerMessage(graph, conv, cust, "My name is Inon and my phone is 0501234567");
    const requested = await handleCustomerMessage(graph, conv, cust, "Yes");

    expect(requested.turn.selectedAction?.name).toBe("createPaymentRequest");
    expect(requested.response.toLowerCase()).not.toMatch(/\bpaid\b|successfully paid/);
    expect(requested.response.toLowerCase()).not.toMatch(/successfully booked|booking confirmed|confirmed appointment/);
    expect(requested.state.stage).toBe("payment");
  });

  it("free no-payment offer bypasses payment and still books cleanly", async () => {
    const { state, turns } = await runScenario({
      name: "real-payment-free-offer",
      graph: buildPersonalTrainerGraph,
      turns: [
        { customer: "Free Fitness Consultation Thursday at 12pm. My name is Inon and my email is inon@example.com" },
        { customer: "Yes" },
      ],
    });

    expect(turns[0].selectedAction?.name).toBe("checkAvailability");
    expect(turns[1].selectedAction?.name).toBe("createBooking");
    expect(state.outcome).toBe("won");
  });

  it("Coach Riley Free Fitness Consultation does not request phone or re-ask known name", async () => {
    const { state, turns } = await runScenario({
      name: "coach-riley-no-phone",
      graph: buildPersonalTrainerGraph,
      turns: [
        { customer: "I want the Free Fitness Consultation Thursday at 12pm. My name is Inon and my email is inon@example.com" },
      ],
    });

    expect(state.knownFields.name).toBe("Inon");
    expect(state.knownFields.email).toBe("inon@example.com");
    expect(state.missingFields).not.toContain("phone");
    expect(turns[0].response.toLowerCase()).not.toMatch(/phone|name/);
    expect(turns[0].selectedAction?.name).toBe("checkAvailability");
  });
});
