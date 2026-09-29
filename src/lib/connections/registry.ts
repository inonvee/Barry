import { getBackend } from "@/lib/store";
import type { ConnectionCapability, ConnectionRecord } from "@/lib/store";
import { defaultConnectionFor } from "@/lib/fabric/registry";
import "@/lib/fabric/connectors";

/**
 * The connection record a business has for a domain: its stored
 * connection, else the domain's registered default. Resolution of what the
 * system can DO lives in the fabric (src/lib/fabric/registry.ts).
 */
export async function resolveConnection(businessId: string, capability: ConnectionCapability): Promise<ConnectionRecord> {
  const connection = await getBackend().getBusinessConnection(businessId, capability);
  if (connection) {
    if (connection.status !== "connected") throw new Error(`${capability} connection for business ${businessId} is not connected`);
    return connection;
  }
  const fallback = defaultConnectionFor(businessId, capability);
  if (fallback) {
    const { provenance: _p, ...record } = fallback;
    void _p;
    return record;
  }
  throw new Error(`No ${capability} connection configured for business ${businessId}`);
}
