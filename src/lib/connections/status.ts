import { getBackend } from "@/lib/store";
import type { ConnectionCapability } from "@/lib/store";
import type { CapabilityProfiles } from "@/lib/capabilities/model";
import {
  credentialSpecFor,
  defaultConnectionFor,
  describeCredentials,
  descriptorFromConnection,
  getConnectorFactory,
  simulationAllowed,
  type CredentialRequirement,
} from "@/lib/fabric/registry";
import { publicDescriptor, type SystemDescriptor } from "@/lib/fabric/system";
import "@/lib/fabric/connectors";

/**
 * Owner-facing view of a business's connections, built from the fabric's
 * system descriptors: capability, system, status, last verification, what
 * setup is still missing — by environment-variable NAME only — and each
 * capability mapping's lifecycle. Credential values, credential references'
 * secrets and raw config never leave the server.
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
  /** The system as the fabric sees it (kind, connector, capability mappings with status/provenance/version), secret-free. */
  system?: ReturnType<typeof publicDescriptor>;
};

/** The domains the owner always sees, even when nothing is connected. */
const ALWAYS_SHOWN: ConnectionCapability[] = ["payments", "scheduling", "commerce", "messaging"];

function view(descriptor: SystemDescriptor, permissions: string[], status: ConnectionView["status"]): ConnectionView {
  const factory = getConnectorFactory(descriptor.connector);
  const setup = describeCredentials(descriptor.auth.credentialsRef, credentialSpecFor(descriptor));
  const missingEnv = setup.filter((s) => s.required && !s.present).map((s) => s.envVar);
  const missing = factory?.setupGaps ? factory.setupGaps(descriptor.config, missingEnv) : missingEnv;
  const pub = publicDescriptor(descriptor, factory?.displayConfigKeys ?? []);
  return {
    capability: descriptor.domain,
    provider: descriptor.system.key,
    status,
    origin: descriptor.provenance.source === "business_connection" ? "business_connection" : "environment_default",
    simulated: descriptor.simulated,
    lastVerifiedAt: descriptor.lastVerifiedAt ?? null,
    permissions,
    settings: pub.config,
    setup,
    missing: factory ? missing : [...missing, `connector for "${descriptor.connector}"`],
    operations: [],
    system: pub,
  };
}

function notConfigured(capability: ConnectionCapability): ConnectionView {
  return { capability, provider: null, status: "not_configured", origin: "none", simulated: false, lastVerifiedAt: null, permissions: [], settings: {}, setup: [], missing: [], operations: [] };
}

export async function describeBusinessConnections(businessId: string, profiles?: CapabilityProfiles): Promise<ConnectionView[]> {
  const stored = await getBackend().listBusinessConnections(businessId);
  const domains = [...ALWAYS_SHOWN, ...stored.map((r) => r.capability).filter((d) => !ALWAYS_SHOWN.includes(d))];
  const views = domains.map((domain): ConnectionView => {
    const record = stored.find((c) => c.capability === domain);
    if (record) return view(descriptorFromConnection(record), record.permissions, record.status);
    const fallback = defaultConnectionFor(businessId, domain);
    if (!fallback) return notConfigured(domain);
    const descriptor = descriptorFromConnection(fallback, fallback.provenance);
    // A simulator where simulation isn't allowed is not a connection at all.
    if (descriptor.simulated && !simulationAllowed()) return notConfigured(domain);
    return view(descriptor, fallback.permissions, "connected");
  });
  return profiles ? views.map((v) => ({ ...v, operations: profiles[v.capability as keyof CapabilityProfiles]?.operations ?? [] })) : views;
}
