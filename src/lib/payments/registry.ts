import { resolveConnectionCredentials } from "@/lib/connections/credentials";
import { resolveConnection } from "@/lib/connections/registry";
import type { ConnectionRecord } from "@/lib/store";
import { MemoryPaymentAdapter } from "./adapters/memory";
import { StripePaymentAdapter } from "./adapters/stripe";
import { PayPlusPaymentAdapter, parsePayPlusEnvironment } from "./adapters/payplus";
import type { PaymentAdapter, PaymentProvider, PaymentWebhookHeaders } from "./adapters/types";

type PaymentAdapterFactory = (connection: ConnectionRecord) => PaymentAdapter;

const factories = new Map<PaymentProvider, PaymentAdapterFactory>([
  ["memory", () => new MemoryPaymentAdapter()],
  ["stripe", (connection) => {
    const credentials = resolveConnectionCredentials(connection);
    return new StripePaymentAdapter({
      secretKey: credentials.secretKey,
      webhookSecret: credentials.webhookSecret,
      successUrl: credentials.successUrl,
      cancelUrl: credentials.cancelUrl,
    });
  }],
  ["payplus", (connection) => {
    const credentials = resolveConnectionCredentials(connection);
    return new PayPlusPaymentAdapter({
      apiKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      paymentPageUid: String(connection.config.paymentPageUid ?? credentials.paymentPageUid ?? ""),
      // Connection config wins; otherwise the scoped PAYPLUS_<REF>_ENVIRONMENT
      // credential decides. Invalid values throw rather than guess.
      environment: parsePayPlusEnvironment(connection.config.environment) ?? parsePayPlusEnvironment(credentials.environment) ?? "staging",
      callbackUrl: credentials.callbackUrl,
      successUrl: credentials.successUrl,
      failureUrl: credentials.failureUrl,
      cancelUrl: credentials.cancelUrl,
    });
  }],
]);

const testFactories = new Map<PaymentProvider, PaymentAdapterFactory>();

export function registerPaymentAdapterFactoryForTests(
  provider: PaymentProvider,
  factory: PaymentAdapterFactory | undefined
): void {
  if (factory) testFactories.set(provider, factory);
  else testFactories.delete(provider);
}

function paymentProvider(value: string): PaymentProvider {
  if (value === "stripe" || value === "payplus" || value === "memory") return value;
  throw new Error(`Unsupported payments provider ${value}`);
}

export async function resolvePaymentAdapterForBusiness(businessId: string): Promise<PaymentAdapter> {
  const connection = await resolveConnection(businessId, "payments");
  const provider = paymentProvider(connection.provider);
  const factory = testFactories.get(provider) ?? factories.get(provider);
  if (!factory) throw new Error(`No payments adapter registered for provider ${provider}`);
  return factory(connection);
}

export async function resolvePaymentAdapterForWebhook(
  rawBody: string,
  headers: PaymentWebhookHeaders
): Promise<PaymentAdapter> {
  const stripeSignature = headers["stripe-signature"] ?? headers["Stripe-Signature"];
  if (stripeSignature) {
    const parsed = JSON.parse(rawBody) as { data?: { object?: { metadata?: Record<string, string> } } };
    const businessId = parsed.data?.object?.metadata?.businessId;
    if (!businessId) throw new Error("Payment webhook business missing");
    return resolvePaymentAdapterForBusiness(businessId);
  }

  const userAgent = headers["user-agent"] ?? headers["User-Agent"];
  if ((Array.isArray(userAgent) ? userAgent[0] : userAgent) === "PayPlus") {
    const parsed = JSON.parse(rawBody) as { businessId?: string; more_info_1?: string; more_info?: string };
    const businessId = parsed.businessId ?? parsed.more_info_1 ?? parsed.more_info?.split(":")[0];
    if (!businessId) throw new Error("Payment webhook business missing");
    return resolvePaymentAdapterForBusiness(businessId);
  }

  const parsed = JSON.parse(rawBody) as { provider?: string; businessId?: string };
  if (parsed.businessId) return resolvePaymentAdapterForBusiness(parsed.businessId);
  if (parsed.provider) {
    const provider = paymentProvider(parsed.provider);
    const fallbackConnection: ConnectionRecord = {
      id: "webhook-provider-fallback",
      businessId: "unknown",
      capability: "payments",
      provider,
      status: "connected",
      config: {},
      credentialsRef: `env:${provider}`,
      permissions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const factory = testFactories.get(provider) ?? factories.get(provider);
    if (!factory) throw new Error(`No payments adapter registered for provider ${provider}`);
    return factory(fallbackConnection);
  }

  return resolvePaymentAdapterForBusiness("legacy");
}
