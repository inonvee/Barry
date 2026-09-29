import type { ConnectionRecord } from "@/lib/store";
import { credentialSpecFor, describeCredentials, listConnectorFactories, resolveCredentialValues, type CredentialRequirement, type CredentialSpec } from "@/lib/fabric/registry";
import "@/lib/fabric/connectors";

/**
 * Credential lookup by reference. Which variables a system needs is
 * declared by its connector (src/lib/fabric/connectors); this module has
 * no knowledge of any vendor. Values never leave the server.
 */

export type EnvCredentials = Record<string, string | undefined>;
export type { CredentialRequirement };

function specForSystem(systemKey: string): CredentialSpec | undefined {
  const factory = listConnectorFactories().find((f) => (f.key === systemKey || f.key.endsWith(`/${systemKey}`)) && f.credentials && typeof f.credentials !== "function");
  return factory?.credentials as CredentialSpec | undefined;
}

export function resolveCredentials(credentialsRef: string, provider: string): EnvCredentials {
  return resolveCredentialValues(credentialsRef, provider, specForSystem(provider));
}

export function resolveConnectionCredentials(connection: ConnectionRecord): EnvCredentials {
  return resolveCredentials(connection.credentialsRef, connection.provider);
}

/** Setup requirements for a connection: the NAMES of the environment variables it reads and whether each is set. Never a value. */
export function describeCredentialRequirements(credentialsRef: string, provider: string): CredentialRequirement[] {
  return describeCredentials(credentialsRef, specForSystem(provider));
}

export { credentialSpecFor };
