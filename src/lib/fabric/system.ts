import type { CapabilityId } from "./capability";
import type { HttpManifest } from "./http-manifest";

/**
 * CANONICAL DESCRIPTION OF A BUSINESS SYSTEM (a "connection").
 *
 * Whatever the business already runs — a payment provider, a store, a
 * calendar, their own ERP, a regional tool BARRY has never seen — BARRY
 * knows it only through this descriptor: what it is, how to reach it, which
 * capabilities it implements (and how sure BARRY is of each mapping), what
 * auth it needs (by NAME — never a value), its health and activation.
 *
 * Existing per-business connection records (business_connections) are
 * converted into descriptors; they are not a second architecture.
 */

export type SystemKind =
  /** An adapter BARRY maintains in this repository (e.g. a payment provider's API). */
  | "first_party"
  /** A generic protocol connector driven by a declarative manifest (e.g. HTTP/JSON). */
  | "generic_protocol"
  /** The business's own/proprietary system, described by a manifest the owner approved. */
  | "custom"
  /** A mapping BARRY proposed from evidence; never executable until validated and activated. */
  | "learned";

/**
 * Lifecycle of ONE capability mapping on a system. Only `active` is ever
 * executed. `proposed` is what inference produces; it becomes `validated`
 * when its manifest passes deterministic checks, `conformance_passed` when
 * the conformance suite passes, and `active` only when the owner activates it.
 */
export type MappingStatus = "proposed" | "validated" | "conformance_passed" | "active" | "disabled";

export type MappingProvenance =
  | { source: "first_party_adapter" }
  | { source: "owner_manifest"; approvedBy?: string; approvedAt?: string }
  | { source: "learned"; evidence: string; confidence: "low" | "medium" | "high"; proposedAt: string };

export type CapabilityMapping = {
  id: CapabilityId;
  /** Contract version the system implements. */
  version: string;
  status: MappingStatus;
  provenance: MappingProvenance;
  /** Consequential mappings from anything but a first-party adapter require owner activation. */
  ownerVerificationRequired: boolean;
  verifiedAt?: string;
  conformance?: { passedAt: string; suite: string };
};

export type SystemHealth = { state: "healthy" | "degraded" | "down" | "unknown"; checkedAt?: string; error?: string };

export type SystemDescriptor = {
  id: string;
  businessId: string;
  system: { key: string; name: string; kind: SystemKind };
  /** Which registered connector drives it: a first-party adapter key, or a generic one ("http-manifest"). */
  connector: string;
  /** The domain this connection was registered under (commerce, payments, shipping, ...). Open-ended. */
  domain: string;
  transport: { type: "adapter" } | { type: "http"; manifest: HttpManifest };
  /**
   * Capability mappings. For first-party adapters this is what the adapter
   * CAN implement; the running connector confirms what it really supports.
   */
  capabilities: CapabilityMapping[];
  /** Where credentials live (e.g. "env:<system>:<name>") and which variable NAMES are required. Never values. */
  auth: { credentialsRef: string };
  /** Non-secret configuration only. */
  config: Record<string, unknown>;
  webhooks?: { event: string; capability: CapabilityId }[];
  rateLimit?: { requestsPerMinute: number };
  health: SystemHealth;
  lastVerifiedAt?: string;
  schemaVersion: 1;
  /** How BARRY came to know this system. */
  provenance: { source: "business_connection" | "environment_default" | "fixture" | "registered_manifest"; ref?: string };
  activation: "proposed" | "active" | "disabled";
  /** A simulator/fixture: allowed only in dev, tests, or explicitly-allowed preview demos. */
  simulated: boolean;
  /** Lower wins when several active systems of one business implement the same capability. */
  priority: number;
};

/** A descriptor without anything the browser/model must not see (config values beyond display-safe keys are dropped). */
export function publicDescriptor(d: SystemDescriptor, displayConfigKeys: readonly string[] = []) {
  const config: Record<string, string> = {};
  for (const key of displayConfigKeys) if (typeof d.config[key] === "string") config[key] = d.config[key] as string;
  return {
    id: d.id,
    system: d.system,
    connector: d.connector,
    domain: d.domain,
    transport: d.transport.type,
    capabilities: d.capabilities.map((c) => ({ id: c.id, version: c.version, status: c.status, provenance: c.provenance.source, ownerVerificationRequired: c.ownerVerificationRequired, verifiedAt: c.verifiedAt ?? null, conformance: c.conformance ?? null })),
    health: d.health,
    lastVerifiedAt: d.lastVerifiedAt ?? null,
    provenance: d.provenance,
    activation: d.activation,
    simulated: d.simulated,
    schemaVersion: d.schemaVersion,
    config,
  };
}
