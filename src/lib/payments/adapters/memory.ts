import crypto from "node:crypto";
import type {
  CreatePaymentLinkInput,
  PaymentAdapter,
  PaymentWebhookHeaders,
  ProviderPayment,
  VerifiedPaymentWebhook,
} from "./types";

const MEMORY_WEBHOOK_SECRET = "barry-memory-payment-secret";

function hmac(body: string): string {
  return crypto.createHmac("sha256", MEMORY_WEBHOOK_SECRET).update(body).digest("hex");
}

export function signedMemoryWebhook(input: {
  eventId: string;
  providerPaymentId: string;
  conversationId: string;
  status: "paid" | "failed" | "cancelled";
}) {
  const body = JSON.stringify(input);
  return { body, headers: { "x-barry-payment-signature": hmac(body) } };
}

export class MemoryPaymentAdapter implements PaymentAdapter {
  readonly name = "memory" as const;
  readonly payments = new Map<string, ProviderPayment>();
  createdCount = 0;

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<ProviderPayment> {
    const existing = [...this.payments.values()].find((payment) => payment.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    this.createdCount += 1;
    const providerPaymentId = `mem_pay_${crypto.createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 16)}`;
    const payment: ProviderPayment = {
      provider: this.name,
      providerPaymentId,
      checkoutUrl: `https://payments.example.test/checkout/${providerPaymentId}`,
      status: "pending",
      createdAt: new Date().toISOString(),
      idempotencyKey: input.idempotencyKey,
    };
    this.payments.set(providerPaymentId, payment);
    return payment;
  }

  async getPaymentStatus(providerPaymentId: string): Promise<ProviderPayment | undefined> {
    return this.payments.get(providerPaymentId);
  }

  async verifyWebhook(rawBody: string, headers: PaymentWebhookHeaders): Promise<VerifiedPaymentWebhook> {
    const signature = headers["x-barry-payment-signature"];
    const value = Array.isArray(signature) ? signature[0] : signature;
    if (!value || value !== hmac(rawBody)) throw new Error("Payment webhook signature invalid");
    const parsed = JSON.parse(rawBody) as {
      eventId: string;
      providerPaymentId: string;
      conversationId?: string;
      status: "paid" | "failed" | "cancelled";
    };
    const payment = this.payments.get(parsed.providerPaymentId);
    if (payment) payment.status = parsed.status;
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
