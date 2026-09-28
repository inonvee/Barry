import crypto from "node:crypto";
import type {
  CreatePaymentLinkInput,
  PaymentAdapter,
  PaymentWebhookHeaders,
  ProviderPayment,
  VerifiedPaymentWebhook,
} from "./types";

type PayPlusEnvironment = "staging" | "production";

type PayPlusPaymentAdapterOptions = {
  apiKey?: string;
  secretKey?: string;
  paymentPageUid?: string;
  environment?: PayPlusEnvironment;
  callbackUrl?: string;
  successUrl?: string;
  failureUrl?: string;
  cancelUrl?: string;
  fetcher?: typeof fetch;
};

const PAYPLUS_BASE_URLS: Record<PayPlusEnvironment, string> = {
  staging: "https://restapidev.payplus.co.il/api/v1.0/",
  production: "https://restapi.payplus.co.il/api/v1.0/",
};

function headerValue(headers: PaymentWebhookHeaders, name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(direct) ? direct[0] : direct;
}

function paymentStatusFromTransaction(transaction: Record<string, unknown>): "pending" | "paid" | "failed" | "cancelled" {
  const status = String(transaction.status ?? transaction.transaction_status ?? "").toLowerCase();
  if (["success", "paid", "approved", "charged"].includes(status)) return "paid";
  if (["failed", "failure", "rejected", "error"].includes(status)) return "failed";
  if (["cancelled", "canceled", "cancel"].includes(status)) return "cancelled";
  return "pending";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstTransaction(json: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = json.data as Record<string, unknown> | Record<string, unknown>[] | undefined;
  if (Array.isArray(data)) return data[0];
  if (!data) return undefined;
  const transactions = data.transactions;
  if (Array.isArray(transactions)) return transactions[0] as Record<string, unknown> | undefined;
  if (data.transaction && typeof data.transaction === "object") return data.transaction as Record<string, unknown>;
  return data;
}

export class PayPlusPaymentAdapter implements PaymentAdapter {
  readonly name = "payplus" as const;
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly paymentPageUid: string;
  private readonly baseUrl: string;
  private readonly callbackUrl: string;
  private readonly successUrl: string;
  private readonly failureUrl: string;
  private readonly cancelUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: PayPlusPaymentAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.PAYPLUS_API_KEY ?? "";
    this.secretKey = options.secretKey ?? process.env.PAYPLUS_SECRET_KEY ?? "";
    this.paymentPageUid = options.paymentPageUid ?? process.env.PAYPLUS_PAYMENT_PAGE_UID ?? "";
    const environment = options.environment ?? (process.env.PAYPLUS_ENVIRONMENT === "production" ? "production" : "staging");
    this.baseUrl = PAYPLUS_BASE_URLS[environment];
    this.callbackUrl = options.callbackUrl ?? process.env.PAYPLUS_CALLBACK_URL ?? "https://example.com/api/payments/webhook";
    this.successUrl = options.successUrl ?? process.env.PAYPLUS_SUCCESS_URL ?? "https://example.com/payment/success";
    this.failureUrl = options.failureUrl ?? process.env.PAYPLUS_FAILURE_URL ?? "https://example.com/payment/failure";
    this.cancelUrl = options.cancelUrl ?? process.env.PAYPLUS_CANCEL_URL ?? "https://example.com/payment/cancel";
    this.fetcher = options.fetcher ?? fetch;
    if (!this.apiKey || !this.secretKey || !this.paymentPageUid) {
      throw new Error("PayPlus payment provider is not configured");
    }
  }

  private async request(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": this.apiKey,
        "secret-key": this.secretKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("Payment provider unavailable");
    return response.json() as Promise<Record<string, unknown>>;
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<ProviderPayment> {
    const json = await this.request("PaymentPages/generateLink", {
      payment_page_uid: this.paymentPageUid,
      amount: input.amount,
      currency_code: input.currency,
      charge_method: 1,
      refURL_success: this.successUrl,
      refURL_failure: this.failureUrl,
      refURL_cancel: this.cancelUrl,
      refURL_callback: this.callbackUrl,
      send_failure_callback: true,
      more_info: input.idempotencyKey,
      more_info_1: input.businessId,
      more_info_2: input.conversationId,
      more_info_3: input.customerId,
    });
    const data = (json.data ?? {}) as Record<string, unknown>;
    const providerPaymentId = String(data.page_request_uid ?? data.payment_request_uid ?? "");
    const checkoutUrl = String(data.payment_page_link ?? data.url ?? "");
    if (!providerPaymentId || !checkoutUrl) throw new Error("PayPlus malformed response");
    return {
      provider: this.name,
      providerPaymentId,
      checkoutUrl,
      status: "pending",
      createdAt: new Date().toISOString(),
      idempotencyKey: input.idempotencyKey,
    };
  }

  async getPaymentStatus(providerPaymentId: string): Promise<ProviderPayment | undefined> {
    const json = await this.request("Transactions/View", { more_info: providerPaymentId });
    const transaction = firstTransaction(json);
    if (!transaction) return undefined;
    return {
      provider: this.name,
      providerPaymentId,
      checkoutUrl: "",
      status: paymentStatusFromTransaction(transaction),
      createdAt: new Date().toISOString(),
      idempotencyKey: String(transaction.more_info ?? providerPaymentId),
    };
  }

  async verifyWebhook(rawBody: string, headers: PaymentWebhookHeaders): Promise<VerifiedPaymentWebhook> {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const userAgent = headerValue(headers, "user-agent");
    const hash = headerValue(headers, "hash");
    if (userAgent !== "PayPlus" || !hash) throw new Error("Payment webhook signature invalid");

    const canonicalBody = JSON.stringify(body);
    const expectedHash = crypto.createHmac("sha256", this.secretKey).update(canonicalBody).digest("base64");
    const left = Buffer.from(hash);
    const right = Buffer.from(expectedHash);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      throw new Error("Payment webhook signature invalid");
    }

    const transactionUid = String(body.transaction_uid ?? body.transactionUid ?? "");
    const providerPaymentId = String(body.payment_request_uid ?? body.page_request_uid ?? "");
    const idempotencyKey = String(body.more_info ?? "");
    const json = await this.request("Transactions/View", transactionUid ? { transaction_uid: transactionUid } : { more_info: idempotencyKey });
    const transaction = firstTransaction(json);
    if (!transaction) throw new Error("Payment provider verification failed");

    const verifiedPaymentId = String(transaction.payment_request_uid ?? transaction.page_request_uid ?? providerPaymentId);
    if (providerPaymentId && verifiedPaymentId && verifiedPaymentId !== providerPaymentId) {
      throw new Error("Payment provider verification mismatch");
    }

    const callbackAmount = numberValue(body.amount);
    const verifiedAmount = numberValue(transaction.amount);
    if (callbackAmount !== undefined && verifiedAmount !== undefined && callbackAmount !== verifiedAmount) {
      throw new Error("Payment provider verification amount mismatch");
    }

    const callbackCurrency = String(body.currency_code ?? body.currency ?? "").toUpperCase();
    const verifiedCurrency = String(transaction.currency_code ?? transaction.currency ?? "").toUpperCase();
    if (callbackCurrency && verifiedCurrency && callbackCurrency !== verifiedCurrency) {
      throw new Error("Payment provider verification currency mismatch");
    }

    return {
      provider: this.name,
      providerEventId: transactionUid || `${providerPaymentId}:${hash}`,
      providerPaymentId: providerPaymentId || verifiedPaymentId,
      status: paymentStatusFromTransaction(transaction),
      verifiedAt: new Date().toISOString(),
      conversationId: String(body.more_info_2 ?? transaction.more_info_2 ?? "") || undefined,
      idempotencyKey: idempotencyKey || String(transaction.more_info ?? "") || undefined,
      amount: verifiedAmount ?? callbackAmount,
      currency: verifiedCurrency || callbackCurrency || undefined,
    };
  }
}
