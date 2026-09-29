import { z } from "zod";
import type { BusinessGraph } from "@/lib/business-graph";
import { capabilityDomain, listCapabilities, type AnyCapabilityContract } from "@/lib/fabric/capability";
import { listBusinessSystems, resolveCapability } from "@/lib/fabric/registry";
import "@/lib/fabric";
import { authoritySummary } from "@/lib/policy/authority";
import type { CapabilitySurfaceEntry } from "@/lib/reasoner/types";
import { ACTION_REQUIREMENTS, usedCapabilities } from "./model";

/**
 * THE BUSINESS'S EFFECTIVE CAPABILITY SURFACE — what this business's own
 * systems can do, that the model may propose through the generic
 * capability action.
 *
 * Business-specific by construction: a capability appears only if one of
 * THIS business's systems maps it. Each entry is a safe summary — id,
 * purpose, read vs consequential, input field names/types, whether it's
 * executable right now, and how the business governs it — never systems,
 * credentials, manifests or endpoints.
 *
 * Capabilities the conversation's typed flows own (cart, checkout, payment
 * links, bookings…), and every capability of a domain THIS business runs
 * through those typed flows, are not offered generically: those flows bind
 * them to richer state (carts, snapshots, slots) and must not be bypassed.
 * Only capabilities one of the business's systems maps are considered.
 */

const TYPED = new Set(Object.values(ACTION_REQUIREMENTS).flat());

function inputSummary(contract: AnyCapabilityContract): CapabilitySurfaceEntry["inputs"] {
  let schema: { properties?: Record<string, { type?: string | string[] }>; required?: string[] };
  try {
    schema = z.toJSONSchema(contract.input, { io: "input", unrepresentable: "any" }) as typeof schema;
  } catch {
    return [];
  }
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {})
    .filter(([name]) => name !== "idempotencyKey") // BARRY supplies it
    .map(([name, p]) => ({ name, type: Array.isArray(p.type) ? p.type.join("|") : (p.type ?? "any"), required: required.has(name) }));
}

export async function buildCapabilitySurface(graph: BusinessGraph): Promise<CapabilitySurfaceEntry[]> {
  const out: CapabilitySurfaceEntry[] = [];
  // Domains this business runs through BARRY's typed flows keep using them (data-derived, per business).
  const typedDomains = new Set<string>(usedCapabilities(graph));
  const mapped = new Set((await listBusinessSystems(graph.business.id).catch(() => [])).flatMap((s) => s.capabilities.map((c) => c.id)));
  for (const contract of listCapabilities()) {
    if (TYPED.has(contract.id) || typedDomains.has(capabilityDomain(contract.id)) || !mapped.has(contract.id)) continue;
    if (contract.conversational === false) continue;
    const resolution = await resolveCapability(graph.business.id, contract.id).catch(() => undefined);
    if (!resolution) continue;
    // Not offered at all when no system of this business maps it.
    if (!resolution.ok && (resolution.code === "no_system" || resolution.code === "unknown_capability" || resolution.code === "not_supported_by_system")) continue;
    const executable = resolution.ok && (resolution.connector.executes ? resolution.connector.executes(contract.id) : Boolean(resolution.connector.execute));
    // Offered only when this business's own system can really execute it now.
    if (!executable) continue;
    out.push({
      id: contract.id,
      purpose: contract.purpose,
      effect: contract.effect,
      inputs: inputSummary(contract),
      available: executable,
      authority: authoritySummary(graph, contract.id),
    });
  }
  return out;
}
