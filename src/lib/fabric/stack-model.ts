import type { SystemDescriptor } from "./system";
import { capabilityDomain, getCapability } from "./capability";
import { reverificationStatus, type Reverification } from "./reverify";

/**
 * ARBITRARY SYSTEM REPRESENTATION — the business's stack as systems, objects, capabilities,
 * dependencies, authority, sources, events, health and versions, derived from descriptors alone.
 * No industry types: an "object" is the noun of a capability id (commerce.cart.create → cart).
 */

export type StackObject = { name: string; domain: string; capabilities: string[] };
export type StackSystem = {
  id: string;
  name: string;
  key: string;
  kind: SystemDescriptor["system"]["kind"];
  domain: string;
  transport: SystemDescriptor["transport"]["type"];
  objects: StackObject[];
  capabilities: { id: string; status: string; version: string; effect: string; authority: string; provenance: string }[];
  dependencies: { on: string; via: "webhook" | "capability" }[];
  authority: { policyGated: number; reads: number; consequential: number };
  sources: string[];
  events: { event: string; capability: string }[];
  health: SystemDescriptor["health"];
  versions: { schema: number; capabilities: Record<string, string> };
  simulated: boolean;
  activation: SystemDescriptor["activation"];
  reverification: Reverification;
};

export type BusinessStack = { systems: StackSystem[]; domains: { domain: string; systems: number; active: number }[]; objects: StackObject[] };

export function businessStack(descriptors: SystemDescriptor[], now = new Date()): BusinessStack {
  const systems: StackSystem[] = descriptors.map((d) => {
    const objects = new Map<string, StackObject>();
    const caps = d.capabilities.map((c) => {
      const contract = getCapability(c.id);
      const parts = c.id.split(".");
      const object = parts[1] ?? parts[0];
      const key = `${capabilityDomain(c.id)}:${object}`;
      const o = objects.get(key) ?? { name: object, domain: capabilityDomain(c.id), capabilities: [] };
      o.capabilities.push(c.id);
      objects.set(key, o);
      return { id: c.id, status: c.status, version: c.version, effect: contract?.effect ?? "unknown", authority: contract?.authority ?? "unknown", provenance: c.provenance.source };
    });
    return {
      id: d.id,
      name: d.system.name,
      key: d.system.key,
      kind: d.system.kind,
      domain: d.domain,
      transport: d.transport.type,
      objects: [...objects.values()],
      capabilities: caps,
      dependencies: (d.webhooks ?? []).map((w) => ({ on: w.event, via: "webhook" as const })),
      authority: { policyGated: caps.filter((c) => c.authority === "policy_gated").length, reads: caps.filter((c) => c.effect === "read").length, consequential: caps.filter((c) => c.effect === "consequential").length },
      sources: [d.provenance.source, ...(d.provenance.ref ? [d.provenance.ref] : [])],
      events: d.webhooks ?? [],
      health: d.health,
      versions: { schema: d.schemaVersion, capabilities: Object.fromEntries(d.capabilities.map((c) => [c.id, c.version])) },
      simulated: d.simulated,
      activation: d.activation,
      reverification: reverificationStatus(d, { now }),
    };
  });
  const byDomain = new Map<string, { systems: number; active: number }>();
  for (const s of systems) {
    const d = byDomain.get(s.domain) ?? { systems: 0, active: 0 };
    d.systems += 1;
    if (s.activation === "active") d.active += 1;
    byDomain.set(s.domain, d);
  }
  const objects = new Map<string, StackObject>();
  for (const s of systems) for (const o of s.objects) {
    const key = `${o.domain}:${o.name}`;
    const cur = objects.get(key) ?? { name: o.name, domain: o.domain, capabilities: [] };
    cur.capabilities = [...new Set([...cur.capabilities, ...o.capabilities])];
    objects.set(key, cur);
  }
  return { systems, domains: [...byDomain.entries()].map(([domain, v]) => ({ domain, ...v })).sort((a, b) => a.domain.localeCompare(b.domain)), objects: [...objects.values()] };
}
