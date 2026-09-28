import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import type { BusinessGraph } from "@/lib/business-graph";
import type { PaymentBinding, PaymentRequestRecord } from "@/lib/store";
import { MemoryPaymentAdapter } from "./adapters/memory";
import type { PaymentAdapter, PaymentWebhookHeaders } from "./adapters/types";
import { resolvePaymentAdapterForBusiness, resolvePaymentAdapterForWebhook } from "./registry";

let adapterOverride: PaymentAdapter | undefined;

export function setPaymentAdapterForTests(adapter: PaymentAdapter | undefined): void {
  adapterOverride = adapter;
}

export function getPaymentAdapter(): PaymentAdapter {
  if (adapterOverride) return adapterOverride;
  return new MemoryPaymentAdapter();
}

async function paymentAdapterForBusiness(businessId: string): Promise<PaymentAdapter> {
  return adapterOverride ?? resolvePaymentAdapterForBusiness(businessId);
}

export type CreatePaymentLinkRequest = {
  graph: BusinessGraph;
  businessId: string;
  conversationId: string;
  customerId: string;
  amount: number;
  currency: string;
  reason: string;
  /** What this money pays for; becomes part of the idempotency key so a changed cart never reuses a stale payment. */
  binding?: PaymentBinding;
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
    ...(input.binding ? [input.binding.kind, input.binding.cartId, input.binding.snapshotHash] : []),
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
  const adapter = await paymentAdapterForBusiness(input.businessId);
  const baseIdempotencyKey = paymentIdempotencyKey(input);
  const idempotencyKey = await nextPaymentAttemptKey(input.businessId, baseIdempotencyKey);
  const existing = await backend.findPaymentRequestByIdempotencyKey(input.businessId, idempotencyKey);
  if (existing && (existing.status === "pending" || existing.status === "paid")) return recordToPayment(existing);

  const providerPayment = await adapter.createPaymentLink({
    ...input,
    idempotencyKey,
  });

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
    binding: input.binding,
  });
  return recordToPayment(record);
}

/** A payment request the conversation no longer points at (its cart changed) — never payable into an order. */
export async function cancelPaymentRequest(paymentRequestId: string): Promise<void> {
  const backend = getBackend();
  const record = await backend.getPaymentRequest(paymentRequestId);
  if (record && record.status === "pending") await backend.updatePaymentRequestStatus(paymentRequestId, "cancelled");
}

/**
 * Ask the PROVIDER whether a payment went through. This is the only
 * thing a customer's "I paid" ever triggers; the answer comes from the
 * provider's API (or an already-recorded verified webhook), never from
 * the customer's words. Amount/currency must match what was requested.
 */
export async function verifyPaymentWithProvider(input: {
  paymentRequestId: string;
  businessId: string;
  conversationId: string;
}): Promise<{ paymentRequestId: string; status: PaymentRequestRecord["status"]; verifiedAt?: string }> {
  const backend = getBackend();
  const record = await backend.getPaymentRequest(input.paymentRequestId);
  if (!record || record.businessId !== input.businessId || record.conversationId !== input.conversationId) {
    throw new Error("Payment request does not belong to this conversation");
  }
  if (record.status === "paid") return { paymentRequestId: record.id, status: "paid", verifiedAt: record.verifiedAt };
  if (record.status !== "pending") return { paymentRequestId: record.id, status: record.status };

  const adapter = await paymentAdapterForBusiness(input.businessId);
  const provider = await adapter.getPaymentStatus({
    providerPaymentId: record.providerPaymentId ?? record.id,
    providerTransactionId: record.providerTransactionId,
    idempotencyKey: record.idempotencyKey,
  });
  if (!provider || provider.status === "pending") return { paymentRequestId: record.id, status: "pending" };
  if (provider.status === "paid") {
    if (provider.amount !== undefined && Math.round(provider.amount * 100) !== Math.round(record.amount * 100)) {
      throw new Error("Payment provider verification amount mismatch");
    }
    if (provider.currency && provider.currency.toUpperCase() !== record.currency.toUpperCase()) {
      throw new Error("Payment provider verification currency mismatch");
    }
  }
  const verifiedAt = new Date().toISOString();
  const updated = await backend.updatePaymentRequestStatus(record.id, provider.status, {
    verifiedAt: provider.status === "paid" ? verifiedAt : undefined,
    providerTransactionId: provider.providerTransactionId,
  });
  return { paymentRequestId: updated.id, status: updated.status, verifiedAt: updated.verifiedAt };
}

export type PaymentWebhookResult = {
  duplicate: boolean;
  /** Verified payment for a payment request the conversation no longer points at (e.g. its cart changed). Recorded for the owner; never resumes the transaction. */
  superseded?: boolean;
  payment?: PaymentRequestRecord;
  provider?: string;
  providerEventId?: string;
};

export async function processPaymentWebhook(
  rawBody: string,
  headers: PaymentWebhookHeaders
): Promise<PaymentWebhookResult> {
  const adapter = adapterOverride ?? (await resolvePaymentAdapterForWebhook(rawBody, headers));
  const verified = await adapter.verifyWebhook(rawBody, headers);
  const backend = getBackend();
  const payment = await backend.findPaymentRequestByProviderPaymentId(
    verified.provider,
    verified.providerPaymentId
  );
  if (!payment) throw new Error("Unknown payment request");
  if (verified.businessId && verified.businessId !== payment.businessId) {
    throw new Error("Payment webhook business mismatch");
  }
  if (verified.conversationId && verified.conversationId !== payment.conversationId) {
    throw new Error("Payment webhook conversation mismatch");
  }
  if (verified.amount !== undefined && verified.amount !== payment.amount) {
    throw new Error("Payment webhook amount mismatch");
  }
  if (verified.currency && verified.currency.toUpperCase() !== payment.currency.toUpperCase()) {
    throw new Error("Payment webhook currency mismatch");
  }

  const event = await backend.recordPaymentWebhookEvent(verified.provider, verified.providerEventId, payment.id);
  if (event.status === "completed") {
    const state = await getConversationStore().get(payment.conversationId);
    if (!state || payment.status !== "paid" || state.stage === "closed") {
      return { duplicate: true, payment, provider: verified.provider, providerEventId: verified.providerEventId };
    }
  }

  const updated = await backend.updatePaymentRequestStatus(payment.id, verified.status, {
    verifiedAt: verified.verifiedAt,
    providerEventId: verified.providerEventId,
    providerTransactionId: verified.providerTransactionId,
  });

  if (verified.status === "paid") {
    const store = getConversationStore();
    const state = await store.get(payment.conversationId);
    if (!state) throw new Error(`Conversation ${payment.conversationId} not found`);
    if (state.customerId !== payment.customerId) throw new Error("Payment customer mismatch");
    if (state.knownFields.__paymentRequestId !== payment.id) {
      // Real money arrived for a payment the conversation superseded (the
      // cart changed after this link was sent). Record it for the owner;
      // it must never complete the NEW transaction.
      state.messages.push({
        role: "system",
        content: `Verified payment ${payment.id} arrived for a superseded checkout — owner review required.`,
        at: new Date().toISOString(),
      });
      await store.save(state);
      await backend.markPaymentWebhookEventCompleted(verified.provider, verified.providerEventId, payment.id);
      return { duplicate: false, superseded: true, payment: updated, provider: verified.provider, providerEventId: verified.providerEventId };
    }
    state.knownFields.__paid = "1";
    await store.save(state);
    return { duplicate: false, payment: updated, provider: verified.provider, providerEventId: verified.providerEventId };
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
    await backend.markPaymentWebhookEventCompleted(verified.provider, verified.providerEventId, payment.id);
  }

  return { duplicate: false, payment: updated, provider: verified.provider, providerEventId: verified.providerEventId };
}

export async function markPaymentWebhookCompleted(result: PaymentWebhookResult): Promise<void> {
  if (!result.payment || !result.provider || !result.providerEventId) return;
  await getBackend().markPaymentWebhookEventCompleted(result.provider, result.providerEventId, result.payment.id);
}

export async function markPaymentWebhookFailed(result: PaymentWebhookResult, error: unknown): Promise<void> {
  if (!result.payment || !result.provider || !result.providerEventId) return;
  const message = error instanceof Error ? error.message : String(error);
  await getBackend().markPaymentWebhookEventFailed(result.provider, result.providerEventId, result.payment.id, message);
}
