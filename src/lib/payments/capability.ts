import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import type { BusinessGraph } from "@/lib/business-graph";
import type { PaymentRequestRecord } from "@/lib/store";
import { MemoryPaymentAdapter } from "./adapters/memory";
import { StripePaymentAdapter } from "./adapters/stripe";
import type { PaymentAdapter, PaymentWebhookHeaders } from "./adapters/types";

let adapterOverride: PaymentAdapter | undefined;

export function setPaymentAdapterForTests(adapter: PaymentAdapter | undefined): void {
  adapterOverride = adapter;
}

export function getPaymentAdapter(): PaymentAdapter {
  if (adapterOverride) return adapterOverride;
  if (process.env.BARRY_PAYMENT_PROVIDER === "stripe") return new StripePaymentAdapter();
  return new MemoryPaymentAdapter();
}

export type CreatePaymentLinkRequest = {
  graph: BusinessGraph;
  businessId: string;
  conversationId: string;
  customerId: string;
  amount: number;
  currency: string;
  reason: string;
};

export type BarryPayment = {
  paymentRequestId: string;
  provider: string;
  providerPaymentId: string;
  checkoutUrl: string;
  status: PaymentRequestRecord["status"];
  createdAt: string;
  verifiedAt?: string;
  idempotencyKey: string;
};

export function paymentIdempotencyKey(input: Omit<CreatePaymentLinkRequest, "graph">): string {
  return [
    input.businessId,
    input.conversationId,
    input.customerId,
    input.amount.toFixed(2),
    input.currency.toUpperCase(),
    input.reason,
  ].join(":");
}

function recordToPayment(record: PaymentRequestRecord): BarryPayment {
  return {
    paymentRequestId: record.id,
    provider: record.provider ?? "memory",
    providerPaymentId: record.providerPaymentId ?? record.id,
    checkoutUrl: record.providerCheckoutUrl ?? "",
    status: record.status,
    createdAt: record.createdAt,
    verifiedAt: record.verifiedAt,
    idempotencyKey: record.idempotencyKey ?? record.id,
  };
}

async function nextPaymentAttemptKey(businessId: string, baseKey: string): Promise<string> {
  const backend = getBackend();
  const existing = (await backend.listPaymentRequests(businessId)).filter(
    (payment) => payment.idempotencyKey === baseKey || payment.idempotencyKey?.startsWith(`${baseKey}:retry:`)
  );
  if (existing.some((payment) => payment.status === "pending" || payment.status === "paid")) {
    return existing.find((payment) => payment.status === "pending" || payment.status === "paid")!.idempotencyKey!;
  }
  if (existing.length === 0) return baseKey;
  return `${baseKey}:retry:${existing.length}`;
}

export async function createPaymentLink(input: CreatePaymentLinkRequest): Promise<BarryPayment> {
  const backend = getBackend();
  const adapter = getPaymentAdapter();
  const baseIdempotencyKey = paymentIdempotencyKey(input);
  const idempotencyKey = await nextPaymentAttemptKey(input.businessId, baseIdempotencyKey);
  const existing = await backend.findPaymentRequestByIdempotencyKey(input.businessId, idempotencyKey);
  if (existing && (existing.status === "pending" || existing.status === "paid")) return recordToPayment(existing);

  const providerExisting = await adapter.findPaymentByIdempotencyKey(idempotencyKey);
  const providerPayment =
    providerExisting ??
    (await adapter.createPaymentLink({
      ...input,
      idempotencyKey,
    }));

  const record = await backend.createPaymentRequest({
    businessId: input.businessId,
    conversationId: input.conversationId,
    customerId: input.customerId,
    amount: input.amount,
    currency: input.currency,
    reason: input.reason,
    provider: providerPayment.provider,
    providerPaymentId: providerPayment.providerPaymentId,
    providerCheckoutUrl: providerPayment.checkoutUrl,
    idempotencyKey,
  });
  return recordToPayment(record);
}

export type PaymentWebhookResult = {
  duplicate: boolean;
  payment?: PaymentRequestRecord;
};

export async function processPaymentWebhook(
  rawBody: string,
  headers: PaymentWebhookHeaders
): Promise<PaymentWebhookResult> {
  const adapter = getPaymentAdapter();
  const verified = await adapter.verifyWebhook(rawBody, headers);
  const backend = getBackend();
  const payment = await backend.findPaymentRequestByProviderPaymentId(
    verified.provider,
    verified.providerPaymentId
  );
  if (!payment) throw new Error("Unknown payment request");
  if (verified.conversationId && verified.conversationId !== payment.conversationId) {
    throw new Error("Payment webhook conversation mismatch");
  }

  const firstEvent = await backend.recordPaymentWebhookEvent(verified.provider, verified.providerEventId, payment.id);
  if (!firstEvent) return { duplicate: true, payment };

  const updated = await backend.updatePaymentRequestStatus(payment.id, verified.status, {
    verifiedAt: verified.verifiedAt,
    providerEventId: verified.providerEventId,
  });

  if (verified.status === "paid") {
    const store = getConversationStore();
    const state = await store.get(payment.conversationId);
    if (!state) throw new Error(`Conversation ${payment.conversationId} not found`);
    if (state.customerId !== payment.customerId) throw new Error("Payment customer mismatch");
    if (state.knownFields.__paymentRequestId !== payment.id) throw new Error("Payment request does not belong to conversation");
    state.knownFields.__paid = "1";
    await store.save(state);
    return { duplicate: false, payment: updated };
  }

  if (verified.status === "failed" || verified.status === "cancelled") {
    const store = getConversationStore();
    const state = await store.get(payment.conversationId);
    if (state && state.knownFields.__paymentRequestId === payment.id) {
      delete state.knownFields.__paymentRequestId;
      delete state.knownFields.__paid;
      state.stage = "payment";
      state.messages.push({
        role: "system",
        content: `Payment ${payment.id} ${verified.status}`,
        at: new Date().toISOString(),
      });
      await store.save(state);
    }
  }

  return { duplicate: false, payment: updated };
}
