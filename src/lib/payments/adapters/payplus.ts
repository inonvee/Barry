import crypto from "node:crypto";
import type {
  CreatePaymentLinkInput,
  PaymentAdapter,
  PaymentStatusRef,
  PaymentWebhookHeaders,
  ProviderPayment,
  VerifiedPaymentWebhook,
} from "./types";

export type PayPlusEnvironment = "staging" | "production";

/** Scoped credential/config value -> environment. Unknown values fail closed instead of silently picking one. */
export function parsePayPlusEnvironment(value: unknown): PayPlusEnvironment | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "staging" || value === "production") return value;
  throw new Error(`Invalid PayPlus environment "${String(value)}"`);
}

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
  if (status === "success") return "paid";
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
  readonly environment: PayPlusEnvironment;

  constructor(options: PayPlusPaymentAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.PAYPLUS_API_KEY ?? "";
    this.secretKey = options.secretKey ?? process.env.PAYPLUS_SECRET_KEY ?? "";
    this.paymentPageUid = options.paymentPageUid ?? process.env.PAYPLUS_PAYMENT_PAGE_UID ?? "";
    this.environment = options.environment ?? parsePayPlusEnvironment(process.env.PAYPLUS_ENVIRONMENT) ?? "staging";
    this.baseUrl = PAYPLUS_BASE_URLS[this.environment];
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

  /**
   * PayPlus identifier contract: `generateLink` returns a PAGE/request
   * uid (page_request_uid / payment_request_uid) — that is NOT a
   * transaction. Transactions/View is queried by `transaction_uid` only
   * once a real transaction uid is durably known (from a verified
   * callback); otherwise by our own durable `more_info` idempotency key.
   * The page uid is never sent as a transaction uid.
   */
  async getPaymentStatus(ref: PaymentStatusRef): Promise<ProviderPayment | undefined> {
    let query: Record<string, unknown>;
    if (ref.providerTransactionId) query = { transaction_uid: ref.providerTransactionId };
    else if (ref.idempotencyKey) query = { more_info: ref.idempotencyKey };
    else return undefined;

    const json = await this.request("Transactions/View", query);
    const transaction = firstTransaction(json);
    if (!transaction) return undefined;

    const moreInfo = transaction.more_info === undefined ? undefined : String(transaction.more_info);
    if (ref.idempotencyKey && moreInfo !== undefined && moreInfo !== ref.idempotencyKey) {
      throw new Error("Payment provider verification mismatch");
    }
    const pageUid = String(transaction.payment_request_uid ?? transaction.page_request_uid ?? "");
    if (pageUid && pageUid !== ref.providerPaymentId) throw new Error("Payment provider verification mismatch");

    const transactionUid = transaction.transaction_uid ?? transaction.uid;
    return {
      provider: this.name,
      providerPaymentId: ref.providerPaymentId,
      providerTransactionId: transactionUid ? String(transactionUid) : undefined,
      checkoutUrl: "",
      status: paymentStatusFromTransaction(transaction),
      createdAt: new Date().toISOString(),
      idempotencyKey: moreInfo ?? ref.idempotencyKey ?? "",
      amount: numberValue(transaction.amount),
      currency: String(transaction.currency_code ?? transaction.currency ?? "").toUpperCase() || undefined,
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
    const verifiedMoreInfo = transaction.more_info === undefined ? undefined : String(transaction.more_info);
    if (idempotencyKey && verifiedMoreInfo !== undefined && verifiedMoreInfo !== idempotencyKey) {
      throw new Error("Payment provider verification mismatch");
    }
    const verifiedTransactionUid = String(transaction.transaction_uid ?? transactionUid ?? "");
    if (transactionUid && verifiedTransactionUid && verifiedTransactionUid !== transactionUid) {
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
      businessId: String(body.more_info_1 ?? transaction.more_info_1 ?? "") || undefined,
      conversationId: String(body.more_info_2 ?? transaction.more_info_2 ?? "") || undefined,
      idempotencyKey: idempotencyKey || String(transaction.more_info ?? "") || undefined,
      amount: verifiedAmount ?? callbackAmount,
      currency: verifiedCurrency || callbackCurrency || undefined,
      providerTransactionId: verifiedTransactionUid || undefined,
    };
  }
}
