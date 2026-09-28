import { afterEach, describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { buildPersonalTrainerGraph } from "@/lib/fixtures/personal-trainer";
import { handleCustomerMessage, handlePaymentWebhook } from "@/lib/runtime";
import { getBackend } from "@/lib/store";
import {
  createPaymentLink,
  setPaymentAdapterForTests,
} from "@/lib/payments/capability";
import { MemoryPaymentAdapter, signedMemoryWebhook } from "@/lib/payments/adapters/memory";
import { runScenario } from "./support/eval-harness";

afterEach(() => {
  setPaymentAdapterForTests(undefined);
});

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
