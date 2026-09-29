import type { ConnectionRecord } from "@/lib/store";
import {
  CapabilityUnavailableError,
  credentialSpecFor,
  getConnectorFactory,
  identifyWebhookBusiness,
  registerConnectorFactory,
  registerDefaultSystemProvider,
  resolveCredentialValues,
  resolveDomainConnector,
  type Connector,
  type ConnectorFactory,
  type ResolvedCredentials,
} from "@/lib/fabric/registry";
import { listCapabilities, normalizeDeclaredCapabilities } from "@/lib/fabric/capability";
import type { SystemDescriptor } from "@/lib/fabric/system";
import "@/lib/fabric/builtin";
import { MemoryPaymentAdapter } from "./adapters/memory";
import { StripePaymentAdapter } from "./adapters/stripe";
import { PayPlusPaymentAdapter, parsePayPlusEnvironment } from "./adapters/payplus";
import type { PaymentAdapter, PaymentProvider, PaymentWebhookHeaders } from "./adapters/types";

/**
 * Payment connectors, registered in the universal connection registry.
 * Vendor specifics — credentials, config, and how each vendor's webhook
 * says which business it belongs to — live inside these factories only.
 */

type PaymentAdapterFactory = (connection: ConnectionRecord) => PaymentAdapter;

const ALL_PAYMENTS = () => listCapabilities("payments").map((c) => c.id);

function paymentConnector(adapter: PaymentAdapter): Connector {
  return {
    systemKey: adapter.name,
    adapter,
    async capabilities() {
      const declared = adapter.describeCapabilities ? await adapter.describeCapabilities() : ["paymentLinks", "statusLookup", "webhookVerification"];
      return normalizeDeclaredCapabilities("payments", declared);
    },
  };
}

function connectionFrom(descriptor: SystemDescriptor): ConnectionRecord {
  const now = new Date().toISOString();
  return {
    id: descriptor.id,
    businessId: descriptor.businessId,
    capability: descriptor.domain,
    provider: descriptor.system.key,
    status: descriptor.activation === "active" ? "connected" : "disconnected",
    config: descriptor.config,
    credentialsRef: descriptor.auth.credentialsRef,
    permissions: [],
    createdAt: now,
    updatedAt: now,
    ...(descriptor.lastVerifiedAt ? { lastVerifiedAt: descriptor.lastVerifiedAt } : {}),
  };
}

function header(headers: PaymentWebhookHeaders, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.replace(/(^|-)\w/g, (m) => m.toUpperCase())];
  return Array.isArray(value) ? value[0] : value;
}

class WebhookBusinessMissingError extends Error {}

const FACTORIES: ConnectorFactory[] = [
  {
    key: "payments/memory",
    name: "BARRY payments simulator",
    kind: "first_party",
    domain: "payments",
    simulated: true,
    potentialCapabilities: ALL_PAYMENTS,
    create: () => paymentConnector(new MemoryPaymentAdapter()),
  },
  {
    key: "stripe",
    name: "Stripe",
    kind: "first_party",
    domain: "payments",
    simulated: false,
    credentials: {
      envPrefix: "stripe",
      keys: [
        { key: "SECRET_KEY", field: "secretKey", required: true },
        { key: "WEBHOOK_SECRET", field: "webhookSecret", required: true },
        { key: "SUCCESS_URL", field: "successUrl", required: false },
        { key: "CANCEL_URL", field: "cancelUrl", required: false },
      ],
    },
    potentialCapabilities: ALL_PAYMENTS,
    create: (_d, c: ResolvedCredentials) =>
      paymentConnector(new StripePaymentAdapter({ secretKey: c.secretKey, webhookSecret: c.webhookSecret, successUrl: c.successUrl, cancelUrl: c.cancelUrl })),
    identifyWebhookBusiness(headers, rawBody) {
      if (!header(headers, "stripe-signature")) return undefined;
      const parsed = JSON.parse(rawBody) as { data?: { object?: { metadata?: Record<string, string> } } };
      const businessId = parsed.data?.object?.metadata?.businessId;
      if (!businessId) throw new WebhookBusinessMissingError("Payment webhook business missing");
      return businessId;
    },
  },
  {
    key: "payplus",
    name: "PayPlus",
    kind: "first_party",
    domain: "payments",
    simulated: false,
    credentials: {
      envPrefix: "payplus",
      keys: [
        { key: "API_KEY", field: "apiKey", required: true },
        { key: "SECRET_KEY", field: "secretKey", required: true },
        { key: "PAYMENT_PAGE_UID", field: "paymentPageUid", required: true },
        { key: "ENVIRONMENT", field: "environment", required: false },
        { key: "CALLBACK_URL", field: "callbackUrl", required: false },
        { key: "SUCCESS_URL", field: "successUrl", required: false },
        { key: "FAILURE_URL", field: "failureUrl", required: false },
        { key: "CANCEL_URL", field: "cancelUrl", required: false },
      ],
    },
    displayConfigKeys: ["environment"],
    potentialCapabilities: ALL_PAYMENTS,
    // A payment page UID set on the connection itself satisfies the credential.
    setupGaps: (config, missing) => (typeof config.paymentPageUid === "string" ? missing.filter((m) => !m.endsWith("PAYMENT_PAGE_UID")) : missing),
    create: (d, c) =>
      paymentConnector(
        new PayPlusPaymentAdapter({
          apiKey: c.apiKey,
          secretKey: c.secretKey,
          paymentPageUid: String(d.config.paymentPageUid ?? c.paymentPageUid ?? ""),
          // Connection config wins; otherwise the scoped PAYPLUS_<REF>_ENVIRONMENT
          // credential decides. Invalid values throw rather than guess.
          environment: parsePayPlusEnvironment(d.config.environment) ?? parsePayPlusEnvironment(c.environment) ?? "staging",
          callbackUrl: c.callbackUrl,
          successUrl: c.successUrl,
          failureUrl: c.failureUrl,
          cancelUrl: c.cancelUrl,
        })
      ),
    identifyWebhookBusiness(headers, rawBody) {
      if (header(headers, "user-agent") !== "PayPlus") return undefined;
      const parsed = JSON.parse(rawBody) as { businessId?: string; more_info_1?: string; more_info?: string };
      const businessId = parsed.businessId ?? parsed.more_info_1 ?? parsed.more_info?.split(":")[0];
      if (!businessId) throw new WebhookBusinessMissingError("Payment webhook business missing");
      return businessId;
    },
  },
];

const originals = new Map<string, ConnectorFactory>();
for (const f of FACTORIES) {
  originals.set(f.key, f);
  registerConnectorFactory(f);
}

function factoryKey(provider: string): string {
  return provider === "memory" ? "payments/memory" : provider;
}

/**
 * Test-only: replace a payment provider's connector with a stand-in adapter
 * (no credentials needed). Resolution still goes through the fabric.
 */
export function registerPaymentAdapterFactoryForTests(provider: PaymentProvider, factory: PaymentAdapterFactory | undefined): void {
  const key = factoryKey(provider);
  const original = originals.get(key)!;
  if (!factory) {
    registerConnectorFactory(original);
    return;
  }
  registerConnectorFactory({
    ...original,
    credentials: undefined,
    setupGaps: undefined,
    create: (descriptor) => paymentConnector(factory(connectionFrom(descriptor))),
  });
}

// Legacy single-tenant configuration: a business with no stored payments
// connection uses BARRY_PAYMENT_PROVIDER (default: the simulator — refused
// wherever simulation isn't allowed, i.e. a real production deployment).
registerDefaultSystemProvider("payments", (businessId) => {
  if (process.env.BARRY_REQUIRE_BUSINESS_CONNECTIONS === "1") return undefined;
  const provider = process.env.BARRY_PAYMENT_PROVIDER || "memory";
  return {
    id: `legacy-${businessId}-payments`,
    businessId,
    capability: "payments",
    provider,
    status: "connected",
    config: {},
    credentialsRef: `env:${provider}`,
    permissions: ["createPaymentLink", "verifyWebhook"],
    provenance: "environment_default",
  };
});

function unavailable(err: unknown): never {
  if (err instanceof CapabilityUnavailableError && err.code === "no_connector") throw new Error(err.message.replace(/^No connector registered for "(.*)"$/, "Unsupported payments provider $1"));
  throw err;
}

export async function resolvePaymentAdapterForBusiness(businessId: string): Promise<PaymentAdapter> {
  try {
    const { connector } = await resolveDomainConnector(businessId, "payments");
    return connector.adapter as PaymentAdapter;
  } catch (err) {
    unavailable(err);
  }
}

/**
 * The adapter that must authenticate an inbound payment event: each
 * connector says whether the event is its own and for which business; the
 * business's own connection then verifies it.
 */
export async function resolvePaymentAdapterForWebhook(rawBody: string, headers: PaymentWebhookHeaders): Promise<PaymentAdapter> {
  const businessId = identifyWebhookBusiness(headers, rawBody);
  if (businessId) return resolvePaymentAdapterForBusiness(businessId);

  const parsed = JSON.parse(rawBody) as { provider?: string; businessId?: string };
  if (parsed.businessId) return resolvePaymentAdapterForBusiness(parsed.businessId);
  if (parsed.provider) {
    const factory = getConnectorFactory(factoryKey(parsed.provider));
    if (!factory || factory.domain !== "payments") throw new Error(`Unsupported payments provider ${parsed.provider}`);
    const now = new Date().toISOString();
    const descriptor: SystemDescriptor = {
      id: "webhook-provider-fallback",
      businessId: "unknown",
      system: { key: parsed.provider, name: factory.name, kind: factory.kind },
      connector: factory.key,
      domain: "payments",
      transport: { type: "adapter" },
      capabilities: [],
      auth: { credentialsRef: `env:${parsed.provider}` },
      config: {},
      health: { state: "unknown", checkedAt: now },
      schemaVersion: 1,
      provenance: { source: "environment_default" },
      activation: "active",
      simulated: factory.simulated,
      priority: 99,
    };
    const connector = await factory.create(descriptor, resolveCredentialValues(descriptor.auth.credentialsRef, descriptor.system.key, credentialSpecFor(descriptor)));
    return connector.adapter as PaymentAdapter;
  }

  return resolvePaymentAdapterForBusiness("legacy");
}
