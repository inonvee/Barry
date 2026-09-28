import crypto from "node:crypto";
import type {
  CreatePaymentLinkInput,
  PaymentAdapter,
  PaymentStatusRef,
  PaymentWebhookHeaders,
  ProviderPayment,
  VerifiedPaymentWebhook,
} from "./types";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

function headerValue(headers: PaymentWebhookHeaders, name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(direct) ? direct[0] : direct;
}

function parseStripeSignature(header: string): { timestamp: string; signatures: string[] } {
  const parts = header.split(",").map((part) => part.split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || signatures.length === 0) throw new Error("Payment webhook signature invalid");
  return { timestamp, signatures };
}

function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  now: () => number,
  toleranceSeconds: number
): void {
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);
  const eventTime = Number(timestamp);
  if (!Number.isFinite(eventTime)) throw new Error("Payment webhook signature invalid");
  if (Math.abs(Math.floor(now() / 1000) - eventTime) > toleranceSeconds) {
    throw new Error("Payment webhook signature invalid");
  }
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  if (
    !signatures.some((sig) => {
      const left = Buffer.from(sig);
      const right = Buffer.from(expected);
      return left.length === right.length && crypto.timingSafeEqual(left, right);
    })
  ) {
    throw new Error("Payment webhook signature invalid");
  }
}

function stripeStatus(session: Record<string, unknown>): "pending" | "paid" | "failed" | "cancelled" {
  if (session.payment_status === "paid") return "paid";
  if (session.status === "expired") return "cancelled";
  return "pending";
}

export class StripePaymentAdapter implements PaymentAdapter {
  readonly name = "stripe" as const;
  /** What BARRY's adapter implements for this provider (not everything the vendor offers — e.g. refunds are not wired yet). */
  async describeCapabilities(): Promise<readonly string[]> {
    return ["paymentLinks", "statusLookup", "webhookVerification"];
  }
  private readonly fetcher: typeof fetch;
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly now: () => number;
  private readonly webhookToleranceSeconds: number;
  private readonly successUrl: string;
  private readonly cancelUrl: string;

  constructor(options: {
    secretKey?: string;
    webhookSecret?: string;
    fetcher?: typeof fetch;
    now?: () => number;
    webhookToleranceSeconds?: number;
    successUrl?: string;
    cancelUrl?: string;
  } = {}) {
    this.secretKey = options.secretKey ?? process.env.STRIPE_SECRET_KEY ?? "";
    this.webhookSecret = options.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? "";
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.webhookToleranceSeconds = options.webhookToleranceSeconds ?? 300;
    this.successUrl = options.successUrl ?? process.env.STRIPE_SUCCESS_URL ?? "https://example.com/payment/success";
    this.cancelUrl = options.cancelUrl ?? process.env.STRIPE_CANCEL_URL ?? "https://example.com/payment/cancel";
    if (!this.secretKey) throw new Error("Stripe payment provider is not configured");
  }

  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${STRIPE_API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error("Payment provider unavailable");
    return response.json() as Promise<Record<string, unknown>>;
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<ProviderPayment> {
    const body = new URLSearchParams({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": input.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(Math.round(input.amount * 100)),
      "line_items[0][price_data][product_data][name]": input.reason,
      client_reference_id: input.idempotencyKey,
      "metadata[businessId]": input.businessId,
      "metadata[conversationId]": input.conversationId,
      "metadata[customerId]": input.customerId,
      "metadata[idempotencyKey]": input.idempotencyKey,
      success_url: this.successUrl,
      cancel_url: this.cancelUrl,
    });

    const session = await this.request("/checkout/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": input.idempotencyKey,
      },
      body,
    });
    return this.sessionToPayment(session, input.idempotencyKey);
  }

  async getPaymentStatus(ref: PaymentStatusRef): Promise<ProviderPayment | undefined> {
    const session = await this.request(`/checkout/sessions/${encodeURIComponent(ref.providerPaymentId)}`);
    return this.sessionToPayment(session, String(session.client_reference_id ?? ""));
  }

  async verifyWebhook(rawBody: string, headers: PaymentWebhookHeaders): Promise<VerifiedPaymentWebhook> {
    if (!this.webhookSecret) throw new Error("Stripe webhook secret is not configured");
    const signature = headerValue(headers, "stripe-signature");
    if (!signature) throw new Error("Payment webhook signature invalid");
    verifyStripeSignature(rawBody, signature, this.webhookSecret, this.now, this.webhookToleranceSeconds);
    const event = JSON.parse(rawBody) as {
      id: string;
      type: string;
      data: { object: Record<string, unknown> };
    };
    const session = event.data.object;
    const status =
      event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded"
        ? stripeStatus(session)
        : event.type === "checkout.session.expired"
          ? "cancelled"
          : event.type === "checkout.session.async_payment_failed"
            ? "failed"
            : "pending";
    const metadata = (session.metadata ?? {}) as Record<string, string>;
    return {
      provider: this.name,
      providerEventId: event.id,
      providerPaymentId: String(session.id),
      status,
      conversationId: metadata.conversationId,
      idempotencyKey: metadata.idempotencyKey ?? String(session.client_reference_id ?? ""),
      verifiedAt: new Date().toISOString(),
    };
  }

  private sessionToPayment(session: Record<string, unknown>, idempotencyKey: string): ProviderPayment {
    return {
      provider: this.name,
      providerPaymentId: String(session.id),
      checkoutUrl: String(session.url ?? ""),
      status: stripeStatus(session),
      createdAt: new Date(Number(session.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      idempotencyKey,
    };
  }
}
