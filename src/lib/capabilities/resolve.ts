import type { BusinessGraph } from "@/lib/business-graph";
import { resolveDomainConnector } from "@/lib/fabric/registry";
import { capabilitiesForAlias } from "@/lib/fabric/capability";
import "@/lib/fabric/connectors";
import { CAPABILITY_OPERATIONS, usedCapabilities, type Capability, type CapabilityProfile, type CapabilityProfiles } from "./model";

/**
 * The business's real, current capability profile per planner domain,
 * derived from the systems the fabric resolves for it — the same gates the
 * runtime uses (activation, health, simulation, credentials). Never contains
 * secrets. Providers are named here only as data (`provider`), never branched on.
 */

type Described = { name?: string };

const DECLARATION_TTL_MS = 5 * 60 * 1000;
/** Per connector ADAPTER instance: a reconnected/swapped system is re-described immediately. */
const declarations = new WeakMap<object, { at: number; operations: readonly string[]; capabilities: string[] }>();

async function profileFor(capability: Capability, used: boolean, businessId: string): Promise<CapabilityProfile> {
  const all = CAPABILITY_OPERATIONS[capability] as readonly string[];
  try {
    const { descriptor, connector } = await resolveDomainConnector(businessId, capability);
    // The planner's tools for these domains use typed adapters; a generic-only system can't serve them yet.
    if (!connector.adapter) throw new Error(`${descriptor.system.name} is not configured for the conversation planner (generic capabilities only)`);
    const adapter = (connector.adapter ?? connector) as Described;
    const cacheKey = connector.adapter && typeof connector.adapter === "object" ? (connector.adapter as object) : connector;
    let hit = declarations.get(cacheKey);
    if (!hit || Date.now() - hit.at >= DECLARATION_TTL_MS) {
      const capabilities = await connector.capabilities();
      // Legacy operation names, for readiness wording: an operation counts when every capability it stands for is provided.
      const ops = all.filter((op) => {
        const ids = capabilitiesForAlias(capability, op);
        return ids.length > 0 && ids.every((i) => capabilities.includes(i));
      });
      hit = { at: Date.now(), operations: ops, capabilities };
      declarations.set(cacheKey, hit);
    }
    const operations = [...hit.operations];
    return {
      capability,
      used,
      provider: adapter.name ?? descriptor.system.key,
      status: "connected",
      simulated: descriptor.simulated,
      operations,
      missingOperations: all.filter((op) => !operations.includes(op)),
      capabilities: hit.capabilities,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notConfigured = /^No \w+ connection configured|not connected|not configured|No commerce connection|simulat/i.test(message);
    return {
      capability,
      used,
      provider: null,
      status: notConfigured ? "not_configured" : "error",
      simulated: false,
      operations: [],
      missingOperations: [...all],
      capabilities: [],
      ...(notConfigured ? {} : { error: "Provider could not be resolved" }),
    };
  }
}

export async function resolveCapabilityProfiles(graph: BusinessGraph): Promise<CapabilityProfiles> {
  const used = new Set(usedCapabilities(graph));
  const id = graph.business.id;
  const [commerce, payments, scheduling, messaging] = await Promise.all([
    profileFor("commerce", used.has("commerce"), id),
    profileFor("payments", used.has("payments"), id),
    profileFor("scheduling", used.has("scheduling"), id),
    // No messaging connector is registered yet — this reports honestly "not configured".
    profileFor("messaging", used.has("messaging"), id),
  ]);
  return { commerce, payments, scheduling, messaging };
}
