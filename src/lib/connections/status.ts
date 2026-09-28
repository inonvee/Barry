import { getBackend } from "@/lib/store";
import type { ConnectionCapability, ConnectionRecord } from "@/lib/store";
import { describeCredentialRequirements, type CredentialRequirement } from "./credentials";
import type { CapabilityProfiles } from "@/lib/capabilities/model";
import { fixtureCatalogForBusiness, fixtureCommerceAllowed } from "@/lib/commerce/registry";
import "@/lib/fixtures";
import { resolveConnection } from "./registry";

/**
 * Owner-facing view of a business's connections. Built for display:
 * capability, provider, status, last verification, and what setup is
 * still missing — by environment-variable NAME only. Credential values,
 * credential references' secrets and raw config never leave the server.
 */

export type ConnectionView = {
  capability: ConnectionCapability;
  provider: string | null;
  status: "connected" | "disconnected" | "error" | "not_configured";
  origin: "business_connection" | "environment_default" | "none";
  simulated: boolean;
  lastVerifiedAt: string | null;
  permissions: string[];
  settings: Record<string, string>;
  setup: CredentialRequirement[];
  missing: string[];
  /** Operations of the capability this provider really supports (from its adapter). */
  operations: string[];
};

const CAPABILITIES: ConnectionCapability[] = ["payments", "scheduling", "commerce", "messaging"];
/** Only config keys that are safe and useful to show. */
const DISPLAY_CONFIG_KEYS = ["environment", "fixtureCatalog"];
const SIMULATED_PROVIDERS = new Set(["memory"]);

function view(capability: ConnectionCapability, connection: ConnectionRecord, origin: ConnectionView["origin"]): ConnectionView {
  const setup = describeCredentialRequirements(connection.credentialsRef, connection.provider);
  const settings: Record<string, string> = {};
  for (const key of DISPLAY_CONFIG_KEYS) {
    const value = connection.config[key];
    if (typeof value === "string") settings[key] = value;
  }
  const missing = setup.filter((s) => s.required && !s.present).map((s) => s.envVar);
  if (connection.provider === "payplus" && typeof connection.config.paymentPageUid === "string") {
    const idx = missing.findIndex((m) => m.endsWith("_PAYMENT_PAGE_UID"));
    if (idx >= 0) missing.splice(idx, 1);
  }
  if (connection.provider === "custom-commerce" && typeof connection.config.baseUrl !== "string") missing.push("config.baseUrl");
  return {
    capability,
    provider: connection.provider,
    status: connection.status,
    origin,
    simulated: SIMULATED_PROVIDERS.has(connection.provider),
    lastVerifiedAt: connection.lastVerifiedAt ?? null,
    permissions: connection.permissions,
    settings,
    setup,
    missing,
    operations: [],
  };
}

export async function describeBusinessConnections(businessId: string, profiles?: CapabilityProfiles): Promise<ConnectionView[]> {
  const views = await describeConnectionRecords(businessId);
  return profiles ? views.map((v) => ({ ...v, operations: profiles[v.capability as keyof CapabilityProfiles]?.operations ?? [] })) : views;
}

async function describeConnectionRecords(businessId: string): Promise<ConnectionView[]> {
  const stored = await getBackend().listBusinessConnections(businessId);
  const views: ConnectionView[] = [];
  for (const capability of CAPABILITIES) {
    const record = stored.find((c) => c.capability === capability);
    if (record) {
      views.push(view(capability, record, "business_connection"));
      continue;
    }
    const fixture = capability === "commerce" ? fixtureCatalogForBusiness(businessId) : undefined;
    if (fixture && fixtureCommerceAllowed()) {
      const now = new Date().toISOString();
      views.push(
        view(
          capability,
          { id: "fixture", businessId, capability, provider: "memory", status: "connected", config: { fixtureCatalog: fixture }, credentialsRef: "env:memory", permissions: ["searchProducts", "addToCart", "createCheckout"], createdAt: now, updatedAt: now },
          "environment_default"
        )
      );
      continue;
    }
    try {
      const fallback = await resolveConnection(businessId, capability);
      views.push(view(capability, fallback, "environment_default"));
    } catch {
      views.push({
        capability,
        provider: null,
        status: "not_configured",
        origin: "none",
        simulated: false,
        lastVerifiedAt: null,
        permissions: [],
        settings: {},
        setup: [],
        missing: [],
        operations: [],
      });
    }
  }
  return views;
}
