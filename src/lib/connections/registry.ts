import { getBackend } from "@/lib/store";
import type { ConnectionCapability, ConnectionRecord } from "@/lib/store";

function legacyConnection(businessId: string, capability: ConnectionCapability): ConnectionRecord | undefined {
  if (process.env.BARRY_REQUIRE_BUSINESS_CONNECTIONS === "1") return undefined;

  const now = new Date().toISOString();
  if (capability === "payments") {
    const provider = process.env.BARRY_PAYMENT_PROVIDER || "memory";
    return {
      id: `legacy-${businessId}-payments`,
      businessId,
      capability,
      provider,
      status: "connected",
      config: {},
      credentialsRef: `env:${provider}`,
      permissions: ["createPaymentLink", "verifyWebhook"],
      createdAt: now,
      updatedAt: now,
    };
  }

  if (capability === "scheduling") {
    const provider = process.env.BARRY_SCHEDULING_PROVIDER === "google-calendar" ? "google-calendar" : "memory";
    return {
      id: `legacy-${businessId}-scheduling`,
      businessId,
      capability,
      provider,
      status: "connected",
      config: {},
      credentialsRef: `env:${provider}`,
      permissions: ["checkAvailability", "createBooking"],
      createdAt: now,
      updatedAt: now,
    };
  }

  return undefined;
}

export async function resolveConnection(
  businessId: string,
  capability: ConnectionCapability
): Promise<ConnectionRecord> {
  const connection = await getBackend().getBusinessConnection(businessId, capability);
  if (connection) {
    if (connection.status !== "connected") {
      throw new Error(`${capability} connection for business ${businessId} is not connected`);
    }
    return connection;
  }

  const fallback = legacyConnection(businessId, capability);
  if (fallback) return fallback;
  throw new Error(`No ${capability} connection configured for business ${businessId}`);
}
