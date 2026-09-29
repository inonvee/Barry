import { getBackend, type ConnectionRecord } from "@/lib/store";
import { isProductionRuntime } from "@/lib/env";
import { getCapability, type CapabilityId } from "./capability";
import type { CapabilityMapping, MappingStatus, SystemDescriptor, SystemKind } from "./system";
import { HttpManifestSchema, manifestCapabilities, type HttpManifest } from "./http-manifest";

/**
 * UNIVERSAL CONNECTION REGISTRY.
 *
 * One place where every kind of system — first-party adapters, generic
 * protocol connectors, the business's own systems described by a manifest,
 * and (once validated) learned mappings — registers what it can do. The
 * runtime asks exactly one question:
 *
 *   "Which healthy, authorized, active connection of business B can
 *    execute capability X?"
 *
 * It never asks which vendor that is. Vendor-specific code lives only
 * inside connector factories (src/lib/fabric/connectors/*), registered here.
 *
 * FAIL CLOSED: unknown capability, no system, inactive mapping, unhealthy
 * or disconnected system, missing credentials, a simulator outside
 * dev/test/allowed-preview — each is an explicit refusal with a reason.
 * Nothing falls back to fixtures, simulators or another provider.
 */

// ── Credentials (by reference; values never leave the server) ───────────

export type CredentialSpec = {
  /** Environment prefix, e.g. "acme_pay" -> ACME_PAY_<REF>_API_KEY. */
  envPrefix: string;
  keys: { key: string; field: string; required: boolean }[];
  /** Fixed variable names used when the reference has no name (legacy single-tenant setups). */
  unscoped?: Record<string, string>;
};

export type ResolvedCredentials = Record<string, string | undefined>;

function envToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

export function credentialEnvName(prefix: string, refName: string | undefined, key: string): string {
  return refName ? `${envToken(prefix)}_${envToken(refName)}_${key}` : `${envToken(prefix)}_${key}`;
}

function parseRef(credentialsRef: string, systemKey: string): { refName?: string } {
  const [scheme, refProvider, refName] = credentialsRef.split(":");
  if (scheme !== "env") throw new Error(`Unsupported credentials reference ${credentialsRef}`);
  if (refProvider && refProvider !== systemKey) throw new Error(`Credentials reference provider mismatch for ${systemKey}`);
  return { refName: refName || undefined };
}

function specEnvName(spec: CredentialSpec, refName: string | undefined, key: string): string {
  if (!refName && spec.unscoped?.[key]) return spec.unscoped[key];
  return credentialEnvName(spec.envPrefix, refName, key);
}

export function resolveCredentialValues(credentialsRef: string, systemKey: string, spec: CredentialSpec | undefined): ResolvedCredentials {
  const { refName } = parseRef(credentialsRef, systemKey);
  const out: ResolvedCredentials = {};
  for (const k of spec?.keys ?? []) out[k.field] = process.env[specEnvName(spec!, refName, k.key)];
  return out;
}

export type CredentialRequirement = { envVar: string; required: boolean; present: boolean };

export function describeCredentials(credentialsRef: string, spec: CredentialSpec | undefined): CredentialRequirement[] {
  if (!spec) return [];
  const [, , refName] = credentialsRef.split(":");
  return spec.keys.map(({ key, required }) => {
    const envVar = specEnvName(spec, refName || undefined, key);
    const value = process.env[envVar];
    return { envVar, required, present: typeof value === "string" && value.length > 0 };
  });
}

// ── Connectors ─────────────────────────────────────────────────────────

export type ExecutionContext = { businessId: string; conversationId?: string; customerId?: string };

export interface Connector {
  readonly systemKey: string;
  /** Capability ids this running connector really supports (may ask the system). */
  capabilities(): Promise<CapabilityId[]>;
  /** Generic, contract-shaped execution. First-party typed adapters may leave it out. */
  execute?(capability: CapabilityId, input: Record<string, unknown>, ctx: ExecutionContext): Promise<unknown>;
  /** The typed first-party adapter, for domain tools that use a richer surface. */
  readonly adapter?: unknown;
}

export type ConnectorFactory = {
  /** Connector type key: a first-party adapter key or a generic protocol ("http-manifest"). */
  key: string;
  name: string;
  kind: SystemKind;
  /** Default domain for first-party adapters. Generic connectors take the connection's. */
  domain?: string;
  simulated: boolean;
  credentials?: CredentialSpec | ((descriptor: SystemDescriptor) => CredentialSpec | undefined);
  /** Config keys safe to show owners/founders. */
  displayConfigKeys?: string[];
  /** Capability ids this connector type can implement (first-party), or per descriptor (manifest). */
  potentialCapabilities: CapabilityId[] | ((descriptor: SystemDescriptor) => CapabilityId[]);
  /** Setup gaps beyond missing required credentials, by NAME (e.g. "config.baseUrl"). May drop env names the config covers. */
  setupGaps?(config: Record<string, unknown>, missingEnv: string[]): string[];
  create(descriptor: SystemDescriptor, credentials: ResolvedCredentials): Connector | Promise<Connector>;
  /** For inbound events: which business an event belongs to, if it's this connector's. */
  identifyWebhookBusiness?(headers: Record<string, string | string[] | undefined>, rawBody: string): string | undefined;
};

const factories = new Map<string, ConnectorFactory>();

export function registerConnectorFactory(factory: ConnectorFactory): void {
  factories.set(factory.key, factory);
}

/**
 * The connector for a stored (domain, system) pair: a domain-scoped
 * registration ("payments/memory") wins over a global one ("<system>").
 */
export function connectorKeyFor(domain: string, systemKey: string): string {
  return factories.has(`${domain}/${systemKey}`) ? `${domain}/${systemKey}` : systemKey;
}

export function getConnectorFactory(key: string): ConnectorFactory | undefined {
  return factories.get(key);
}

export function listConnectorFactories(): ConnectorFactory[] {
  return [...factories.values()];
}

export function credentialSpecFor(descriptor: SystemDescriptor): CredentialSpec | undefined {
  const f = factories.get(descriptor.connector);
  if (!f?.credentials) return undefined;
  return typeof f.credentials === "function" ? f.credentials(descriptor) : f.credentials;
}

// ── Default systems (development defaults, simulator fixtures) ───────────

/**
 * A domain module may offer a default connection for a business that has
 * none stored (legacy single-tenant env configuration, simulator fixtures).
 * Defaults are descriptors like any other and go through the same gates —
 * a simulated default is refused wherever simulation is not allowed.
 */
export type DefaultSystemProvider = (businessId: string) => (Omit<ConnectionRecord, "createdAt" | "updatedAt"> & { provenance: "environment_default" | "fixture" }) | undefined;

const defaultProviders = new Map<string, DefaultSystemProvider>();

export function registerDefaultSystemProvider(domain: string, provider: DefaultSystemProvider): void {
  defaultProviders.set(domain, provider);
}

/** The default connection a domain offers a business with no stored connection for it, if any. */
export function defaultConnectionFor(businessId: string, domain: string): (ConnectionRecord & { provenance: "environment_default" | "fixture" }) | undefined {
  const d = defaultProviders.get(domain)?.(businessId);
  if (!d) return undefined;
  const now = new Date().toISOString();
  return { ...d, createdAt: now, updatedAt: now };
}

/** Simulators/fixtures run only in dev and tests, or where a deployment explicitly allows them (preview demos). */
export function simulationAllowed(): boolean {
  if (!isProductionRuntime()) return true;
  return process.env.VERCEL_ENV === "preview" || process.env.BARRY_ALLOW_SIMULATION === "1" || process.env.BARRY_ALLOW_FIXTURE_COMMERCE === "1";
}

// ── Descriptors from state ─────────────────────────────────────────────

type StoredMapping = { status?: MappingStatus; provenance?: CapabilityMapping["provenance"]; verifiedAt?: string; conformance?: CapabilityMapping["conformance"]; version?: string };

const PRIORITY: Record<SystemDescriptor["provenance"]["source"], number> = { business_connection: 10, registered_manifest: 20, environment_default: 50, fixture: 60 };

export function descriptorFromConnection(record: Omit<ConnectionRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }, source: SystemDescriptor["provenance"]["source"] = "business_connection"): SystemDescriptor {
  const manifestRaw = record.config.manifest;
  const manifest = manifestRaw !== undefined ? HttpManifestSchema.safeParse(manifestRaw) : undefined;
  const connectorKey = manifestRaw !== undefined ? "http-manifest" : connectorKeyFor(record.capability, record.provider);
  const factory = factories.get(connectorKey);
  const stored = (typeof record.config.mappings === "object" && record.config.mappings !== null ? record.config.mappings : {}) as Record<string, StoredMapping>;
  const kind: SystemKind = manifestRaw !== undefined ? (record.config.kind === "generic_protocol" ? "generic_protocol" : "custom") : (factory?.kind ?? "first_party");

  const base: SystemDescriptor = {
    id: record.id,
    businessId: record.businessId,
    system: { key: record.provider, name: typeof record.config.name === "string" ? record.config.name : (factory?.name ?? record.provider), kind },
    connector: connectorKey,
    domain: record.capability,
    transport: manifest?.success ? { type: "http", manifest: manifest.data } : { type: "adapter" },
    capabilities: [],
    auth: { credentialsRef: record.credentialsRef },
    config: record.config,
    health: record.status === "error" ? { state: "down", error: "connection reported an error" } : { state: "unknown" },
    ...(record.lastVerifiedAt ? { lastVerifiedAt: record.lastVerifiedAt } : {}),
    schemaVersion: 1,
    provenance: { source, ref: record.id },
    // An erroring connection is still the business's active choice — it is UNHEALTHY, not switched off.
    activation: record.status === "disconnected" ? "disabled" : "active",
    simulated: factory?.simulated ?? false,
    priority: typeof record.config.priority === "number" ? record.config.priority : PRIORITY[source],
  };
  if (manifestRaw !== undefined && !manifest?.success) {
    base.health = { state: "down", error: "manifest is not valid" };
  }

  const ids = manifest?.success ? manifestCapabilities(manifest.data) : factory ? (typeof factory.potentialCapabilities === "function" ? factory.potentialCapabilities(base) : factory.potentialCapabilities) : [];
  base.capabilities = ids.map((id): CapabilityMapping => {
    const s = stored[id] ?? {};
    const contract = getCapability(id);
    const firstParty = kind === "first_party";
    return {
      id,
      version: s.version ?? contract?.version ?? "0.0.0",
      // First-party adapters are maintained and tested in this repository; any other mapping
      // is only as far along its lifecycle as its stored state says (default: proposed).
      status: s.status ?? (firstParty ? "active" : "proposed"),
      provenance: s.provenance ?? (firstParty ? { source: "first_party_adapter" } : { source: "owner_manifest" }),
      ownerVerificationRequired: !firstParty && contract?.effect === "consequential",
      ...(s.verifiedAt ? { verifiedAt: s.verifiedAt } : {}),
      ...(s.conformance ? { conformance: s.conformance } : {}),
    };
  });
  return base;
}

/**
 * Every system a business has, from state: its stored connections, plus a
 * default per domain it has no stored connection for.
 */
export async function listBusinessSystems(businessId: string): Promise<SystemDescriptor[]> {
  const stored = await getBackend().listBusinessConnections(businessId);
  const out = stored.map((r) => descriptorFromConnection(r));
  const domains = new Set(stored.map((r) => r.capability));
  for (const [domain, provider] of defaultProviders) {
    if (domains.has(domain)) continue;
    const d = provider(businessId);
    if (d) out.push(descriptorFromConnection(d, d.provenance));
  }
  return out.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

// ── Resolution ─────────────────────────────────────────────────────────

export type ResolutionRefusal =
  | "unknown_capability"
  | "no_system"
  | "mapping_not_active"
  | "system_inactive"
  | "system_unhealthy"
  | "simulation_not_allowed"
  | "no_connector"
  | "not_configured"
  | "not_supported_by_system"
  | "connector_error";

export type Resolution =
  | { ok: true; descriptor: SystemDescriptor; connector: Connector; mapping: CapabilityMapping }
  | { ok: false; code: ResolutionRefusal; reason: string; system?: string };

export class CapabilityUnavailableError extends Error {
  constructor(readonly code: ResolutionRefusal, message: string) {
    super(message);
  }
}

async function instantiate(descriptor: SystemDescriptor): Promise<{ ok: true; connector: Connector } | { ok: false; code: ResolutionRefusal; reason: string }> {
  if (descriptor.activation !== "active") return { ok: false, code: "system_inactive", reason: `${descriptor.system.name} is ${descriptor.activation}` };
  if (descriptor.health.state === "down") return { ok: false, code: "system_unhealthy", reason: `${descriptor.system.name} is down: ${descriptor.health.error ?? "unhealthy"}` };
  if (descriptor.simulated && !simulationAllowed()) return { ok: false, code: "simulation_not_allowed", reason: `${descriptor.system.name} is a simulator and simulation is not allowed here` };
  const factory = factories.get(descriptor.connector);
  if (!factory) return { ok: false, code: "no_connector", reason: `No connector registered for "${descriptor.connector}"` };
  const spec = credentialSpecFor(descriptor);
  let credentials: ResolvedCredentials;
  try {
    credentials = resolveCredentialValues(descriptor.auth.credentialsRef, descriptor.system.key, spec);
  } catch (err) {
    return { ok: false, code: "not_configured", reason: err instanceof Error ? err.message : "credentials unavailable" };
  }
  const missing = (spec?.keys ?? []).filter((k) => k.required && !credentials[k.field]).map((k) => k.key);
  const gaps = factory.setupGaps ? factory.setupGaps(descriptor.config, missing) : missing;
  if (gaps.length > 0) return { ok: false, code: "not_configured", reason: `${descriptor.system.name} is missing ${gaps.join(", ")}` };
  try {
    return { ok: true, connector: await factory.create(descriptor, credentials) };
  } catch (err) {
    return { ok: false, code: "connector_error", reason: err instanceof Error ? err.message : "connector failed to start" };
  }
}

/**
 * Which healthy, authorized, active connection of this business can execute
 * this capability? The candidate with the lowest priority whose mapping for
 * the capability is ACTIVE is selected, deterministically. If that system
 * can't serve (inactive, unhealthy, unconfigured, doesn't really support
 * it), resolution FAILS — it never silently moves on to another system.
 */
export async function resolveCapability(businessId: string, capabilityId: CapabilityId): Promise<Resolution> {
  if (!getCapability(capabilityId)) return { ok: false, code: "unknown_capability", reason: `Unknown capability ${capabilityId}` };
  const systems = await listBusinessSystems(businessId);
  const candidates = systems.filter((s) => s.capabilities.some((c) => c.id === capabilityId));
  if (candidates.length === 0) return { ok: false, code: "no_system", reason: `No connected system of business ${businessId} implements ${capabilityId}` };
  const selected = candidates.find((s) => s.capabilities.find((c) => c.id === capabilityId)?.status === "active");
  if (!selected) {
    const first = candidates[0];
    const status = first.capabilities.find((c) => c.id === capabilityId)?.status;
    return { ok: false, code: "mapping_not_active", reason: `${first.system.name} maps ${capabilityId} but the mapping is ${status}, not active`, system: first.id };
  }
  const mapping = selected.capabilities.find((c) => c.id === capabilityId)!;
  const started = await instantiate(selected);
  if (!started.ok) return { ...started, system: selected.id };
  let supported: CapabilityId[];
  try {
    supported = await started.connector.capabilities();
  } catch (err) {
    return { ok: false, code: "connector_error", reason: err instanceof Error ? err.message : "capability discovery failed", system: selected.id };
  }
  if (!supported.includes(capabilityId)) return { ok: false, code: "not_supported_by_system", reason: `${selected.system.name} does not support ${capabilityId}`, system: selected.id };
  return { ok: true, descriptor: selected, connector: started.connector, mapping };
}

/**
 * The primary system a business registered for a DOMAIN, as a running
 * connector — used by first-party domain tools that speak a typed adapter
 * surface. Same gates as resolveCapability. Errors keep their historical
 * wording ("No <domain> connection configured ...").
 */
export async function resolveDomainConnector(businessId: string, domain: string): Promise<{ descriptor: SystemDescriptor; connector: Connector }> {
  const stored = await getBackend().getBusinessConnection(businessId, domain);
  let descriptor: SystemDescriptor | undefined;
  if (stored) {
    if (stored.status !== "connected") throw new CapabilityUnavailableError("system_inactive", `${domain} connection for business ${businessId} is not connected`);
    descriptor = descriptorFromConnection(stored);
  } else {
    const d = defaultProviders.get(domain)?.(businessId);
    if (d) descriptor = descriptorFromConnection(d, d.provenance);
  }
  if (!descriptor) throw new CapabilityUnavailableError("no_system", `No ${domain} connection configured for business ${businessId}`);
  const started = await instantiate(descriptor);
  if (!started.ok) throw new CapabilityUnavailableError(started.code, started.reason);
  return { descriptor, connector: started.connector };
}

/** Which business an inbound event belongs to, asked of every connector that handles events — no vendor sniffing outside connectors. */
export function identifyWebhookBusiness(headers: Record<string, string | string[] | undefined>, rawBody: string): string | undefined {
  for (const f of factories.values()) {
    const id = f.identifyWebhookBusiness?.(headers, rawBody);
    if (id) return id;
  }
  return undefined;
}

/** Test helper: connection-shaped input for a manifest-described system. */
export function manifestConnection(input: {
  businessId: string;
  systemKey: string;
  domain: string;
  name: string;
  manifest: HttpManifest | unknown;
  mappings?: Record<string, StoredMapping>;
  status?: ConnectionRecord["status"];
  priority?: number;
  credentialsRef?: string;
}): Omit<ConnectionRecord, "id" | "createdAt" | "updatedAt"> {
  return {
    businessId: input.businessId,
    capability: input.domain,
    provider: input.systemKey,
    status: input.status ?? "connected",
    config: { name: input.name, manifest: input.manifest, mappings: input.mappings ?? {}, ...(input.priority !== undefined ? { priority: input.priority } : {}) },
    credentialsRef: input.credentialsRef ?? `env:${input.systemKey}`,
    permissions: [],
  };
}
