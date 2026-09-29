import type { BusinessGraph } from "@/lib/business-graph";
import { resolveCommerceAdapterForBusiness } from "@/lib/commerce/registry";
import { resolvePaymentAdapterForBusiness } from "@/lib/payments/registry";
import { resolveSchedulingAdapterForBusiness } from "@/lib/scheduling/registry";
import { normalizeDeclaredCapabilities } from "@/lib/fabric/capability";
import { CAPABILITY_OPERATIONS, usedCapabilities, type Capability, type CapabilityProfile, type CapabilityProfiles } from "./model";

/** Adapters may describe their operations; absent that, the base interface contract is assumed. */
type Describable = { name: string; describeCapabilities?: () => Promise<readonly string[]> };

const SIMULATED = new Set(["memory"]);
const DECLARATION_TTL_MS = 5 * 60 * 1000;
/** Per adapter INSTANCE: a reconnected/swapped provider is re-described immediately. */
const declarations = new WeakMap<object, { at: number; operations: readonly string[] }>();

async function declaredOperations(adapter: Describable, baseContract: readonly string[]): Promise<readonly string[]> {
  if (!adapter.describeCapabilities) return baseContract;
  const hit = declarations.get(adapter);
  if (hit && Date.now() - hit.at < DECLARATION_TTL_MS) return hit.operations;
  const operations = await adapter.describeCapabilities();
  declarations.set(adapter, { at: Date.now(), operations });
  return operations;
}

async function profileFor(
  capability: Capability,
  used: boolean,
  resolve: () => Promise<Describable>,
  baseContract: readonly string[]
): Promise<CapabilityProfile> {
  const all = CAPABILITY_OPERATIONS[capability] as readonly string[];
  try {
    const adapter = await resolve();
    const declared = await declaredOperations(adapter, baseContract);
    const operations = all.filter((op) => declared.includes(op));
    return {
      capability,
      used,
      provider: adapter.name,
      status: "connected",
      simulated: SIMULATED.has(adapter.name),
      operations,
      missingOperations: all.filter((op) => !operations.includes(op)),
      capabilities: normalizeDeclaredCapabilities(capability, declared),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notConfigured = /^No \w+ connection configured|not connected|not configured|No commerce connection/i.test(message);
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

/** The business's real, current capability profile. Never contains secrets. */
export async function resolveCapabilityProfiles(graph: BusinessGraph): Promise<CapabilityProfiles> {
  const used = new Set(usedCapabilities(graph));
  const [commerce, payments, scheduling] = await Promise.all([
    profileFor("commerce", used.has("commerce"), () => resolveCommerceAdapterForBusiness(graph.business.id), CAPABILITY_OPERATIONS.commerce.filter((op) => op !== "orderStatus")),
    profileFor("payments", used.has("payments"), () => resolvePaymentAdapterForBusiness(graph.business.id), ["paymentLinks", "statusLookup", "webhookVerification"]),
    profileFor("scheduling", used.has("scheduling"), () => resolveSchedulingAdapterForBusiness(graph.business.id), ["availability", "booking", "bookingLookup"]),
  ]);
  return {
    commerce,
    payments,
    scheduling,
    // No messaging adapter exists yet — reported honestly, never assumed.
    messaging: { capability: "messaging", used: false, provider: null, status: "not_configured", simulated: false, operations: [], missingOperations: ["send"], capabilities: [] },
  };
}
