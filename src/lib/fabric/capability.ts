import { z } from "zod";

/**
 * UNIVERSAL CAPABILITY CONTRACT.
 *
 * A capability is something a business system can do for BARRY, named in a
 * namespaced, open vocabulary — `payments.verify`, `commerce.cart.update`,
 * `shipping.track`, `procurement.quote.request`, or anything a future
 * business needs. There is no closed enum: a new domain is a new
 * registration, never a change to the planner, the runtime or this file.
 *
 * The contract is what BARRY's deterministic side relies on, whoever
 * implements it: the shape of input and output (validated on every call),
 * whether a call changes the world (consequential) and therefore needs
 * policy, idempotency and external verification before BARRY may claim
 * success, and where the definition came from.
 */

export const CAPABILITY_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/;

export type CapabilityId = string;

export type CapabilityEffect =
  /** Reads the world. Safe to retry; never needs owner approval by itself. */
  | "read"
  /** Changes the world (money, orders, bookings, messages, records). */
  | "consequential";

export type CapabilityContract<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = {
  id: CapabilityId;
  /** Semver of the contract. A connector declares which version it implements. */
  version: string;
  purpose: string;
  input: I;
  output: O;
  effect: CapabilityEffect;
  /**
   * How success is established. `provider_confirmed`: the connector's output
   * must carry `verified: true` from the external system — a 2xx alone is
   * not success. `none`: reads, whose normalized output is the result.
   */
  verification: "provider_confirmed" | "none";
  /**
   * `key_required`: every call carries an idempotency key and the connector
   * must return the same result for the same key (checked by conformance).
   */
  idempotency: "none" | "key_required";
  /** Consequential capabilities are policy-gated: the Policy Engine and the business's authority decide, never the model. */
  authority: "none" | "policy_gated";
  /** Who defined this contract. Core contracts ship with BARRY; others are registered by business manifests. */
  provenance: { source: "barry_core" | "business_manifest"; ref?: string };
  /**
   * Legacy operation names that adapters written before the fabric declare
   * (e.g. "checkout"). Only for migration: new connectors declare ids.
   */
  aliases?: string[];
  /** Example inputs used by the conformance suite. */
  examples?: { valid: unknown; invalid: unknown };
};

export type AnyCapabilityContract = CapabilityContract<z.ZodType, z.ZodType>;

export class CapabilityContractError extends Error {}

const contracts = new Map<CapabilityId, AnyCapabilityContract>();

export function capabilityDomain(id: CapabilityId): string {
  return id.split(".")[0];
}

function validateContract(contract: AnyCapabilityContract): void {
  if (!CAPABILITY_ID.test(contract.id)) throw new CapabilityContractError(`Invalid capability id "${contract.id}" — use lowercase dotted segments like "shipping.track"`);
  if (!/^\d+\.\d+\.\d+$/.test(contract.version)) throw new CapabilityContractError(`Capability ${contract.id}: version must be semver`);
  if (contract.effect === "consequential" && contract.authority !== "policy_gated") {
    throw new CapabilityContractError(`Capability ${contract.id}: a consequential capability must be policy-gated`);
  }
  if (contract.effect === "consequential" && contract.verification !== "provider_confirmed") {
    throw new CapabilityContractError(`Capability ${contract.id}: a consequential capability must require provider confirmation`);
  }
}

/**
 * Registers a capability contract. Re-registering the same id with a
 * different version or effect is refused — a contract can't silently change
 * under connectors that already implement it.
 */
export function registerCapability(contract: AnyCapabilityContract): AnyCapabilityContract {
  validateContract(contract);
  const existing = contracts.get(contract.id);
  if (existing) {
    if (existing.version !== contract.version || existing.effect !== contract.effect) {
      throw new CapabilityContractError(`Capability ${contract.id} is already registered as ${existing.version}/${existing.effect}`);
    }
    return existing;
  }
  contracts.set(contract.id, contract);
  return contract;
}

export function getCapability(id: CapabilityId): AnyCapabilityContract | undefined {
  return contracts.get(id);
}

export function listCapabilities(domain?: string): AnyCapabilityContract[] {
  return [...contracts.values()].filter((c) => !domain || capabilityDomain(c.id) === domain);
}

/** Capability ids a legacy operation name stands for (e.g. "cart" -> commerce.cart.create + commerce.cart.update). */
export function capabilitiesForAlias(domain: string, alias: string): CapabilityId[] {
  return listCapabilities(domain)
    .filter((c) => c.aliases?.includes(alias))
    .map((c) => c.id);
}

/** Maps what an adapter declares (ids, or legacy operation names) to capability ids. */
export function normalizeDeclaredCapabilities(domain: string, declared: readonly string[]): CapabilityId[] {
  const out = new Set<CapabilityId>();
  for (const d of declared) {
    if (CAPABILITY_ID.test(d) && contracts.has(d)) out.add(d);
    else for (const id of capabilitiesForAlias(domain, d)) out.add(id);
  }
  return [...out];
}

/** Test-only: forget contracts registered by a test (never core ones). */
export function unregisterCapabilityForTests(id: CapabilityId): void {
  const c = contracts.get(id);
  if (c && c.provenance.source !== "barry_core") contracts.delete(id);
}
