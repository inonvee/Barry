import type { BusinessGraph } from "@/lib/business-graph";
import type { PaymentRequestRecord } from "@/lib/store";

export type PaymentProvider = "memory" | "stripe" | "payplus";
export type PaymentStatus = PaymentRequestRecord["status"];

export type CreatePaymentLinkInput = {
  graph: BusinessGraph;
  businessId: string;
  conversationId: string;
  customerId: string;
  amount: number;
  currency: string;
  reason: string;
  idempotencyKey: string;
};

/**
 * Everything BARRY durably knows about a payment when it asks the
 * provider for status. Providers use different identifiers for the
 * payment LINK/page and the actual TRANSACTION (PayPlus: page_request_uid
 * vs transaction_uid) — an adapter must only use each for what it is.
 */
export type PaymentStatusRef = {
  providerPaymentId: string;
  /** Only present once the provider actually reported a transaction id. */
  providerTransactionId?: string;
  idempotencyKey?: string;
};

export type ProviderPayment = {
  provider: PaymentProvider;
  providerPaymentId: string;
  checkoutUrl: string;
  status: PaymentStatus;
  createdAt: string;
  idempotencyKey: string;
  providerTransactionId?: string;
  amount?: number;
  currency?: string;
};

export type VerifiedPaymentWebhook = {
  provider: PaymentProvider;
  providerEventId: string;
  providerPaymentId: string;
  status: PaymentStatus;
  verifiedAt: string;
  conversationId?: string;
  businessId?: string;
  idempotencyKey?: string;
  amount?: number;
  currency?: string;
  providerTransactionId?: string;
};

export type PaymentWebhookHeaders = Record<string, string | string[] | undefined>;

export interface PaymentAdapter {
  readonly name: PaymentProvider;
  /** Operations of its capability this adapter really supports (see lib/capabilities). */
  describeCapabilities?(): Promise<readonly string[]>;
  createPaymentLink(input: CreatePaymentLinkInput): Promise<ProviderPayment>;
  getPaymentStatus(ref: PaymentStatusRef): Promise<ProviderPayment | undefined>;
  verifyWebhook(rawBody: string, headers: PaymentWebhookHeaders): Promise<VerifiedPaymentWebhook>;
}
