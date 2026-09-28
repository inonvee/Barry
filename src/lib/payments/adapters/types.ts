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

export type ProviderPayment = {
  provider: PaymentProvider;
  providerPaymentId: string;
  checkoutUrl: string;
  status: PaymentStatus;
  createdAt: string;
  idempotencyKey: string;
};

export type VerifiedPaymentWebhook = {
  provider: PaymentProvider;
  providerEventId: string;
  providerPaymentId: string;
  status: PaymentStatus;
  verifiedAt: string;
  conversationId?: string;
  idempotencyKey?: string;
  amount?: number;
  currency?: string;
};

export type PaymentWebhookHeaders = Record<string, string | string[] | undefined>;

export interface PaymentAdapter {
  readonly name: PaymentProvider;
  createPaymentLink(input: CreatePaymentLinkInput): Promise<ProviderPayment>;
  getPaymentStatus(providerPaymentId: string): Promise<ProviderPayment | undefined>;
  verifyWebhook(rawBody: string, headers: PaymentWebhookHeaders): Promise<VerifiedPaymentWebhook>;
}
