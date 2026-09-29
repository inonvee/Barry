import { getCapability, type AnyCapabilityContract, type CapabilityId } from "./capability";
import { resolveCapability, type Connector, type ExecutionContext, type ResolutionRefusal } from "./registry";
import type { SystemDescriptor } from "./system";

/**
 * THE CAPABILITY EXECUTION CONTRACT — identical for every system:
 *
 *   contract -> input validation -> idempotency key (consequential)
 *   -> resolution (business's active, healthy, authorized system)
 *   -> authority (policy decides consequential calls; no decision = no call)
 *   -> connector execution
 *   -> output validation against the contract
 *   -> verification (a consequential call succeeded only if the system confirmed it)
 *
 * A system's error stays that system's error (`provider_error`); nothing is
 * retried on another system; nothing unverified is reported as success.
 */

export type ExecutionFailure =
  | ResolutionRefusal
  | "invalid_input"
  | "idempotency_key_required"
  | "not_authorized"
  | "requires_approval"
  | "not_executable"
  | "provider_error"
  | "invalid_output"
  | "unverified";

export type CapabilityProvenance = {
  capability: CapabilityId;
  version: string;
  systemId: string;
  system: string;
  connector: string;
  simulated: boolean;
};

export type CapabilityResult =
  | { ok: true; output: Record<string, unknown>; provenance: CapabilityProvenance }
  | { ok: false; code: ExecutionFailure; reason: string; provenance?: Partial<CapabilityProvenance> };

export type AuthorityDecision = { status: "allowed" | "requires_approval" | "denied"; reason: string };

/**
 * Decides whether a consequential call may run. Supplied by the caller
 * (the runtime's Policy Engine for this business). There is deliberately no
 * default: without an authority decision a consequential call does not run.
 */
export type Authorizer = (request: { capability: CapabilityId; input: Record<string, unknown>; system: SystemDescriptor }) => AuthorityDecision | Promise<AuthorityDecision>;

function provenanceOf(capability: CapabilityId, version: string, d: SystemDescriptor): CapabilityProvenance {
  return { capability, version, systemId: d.id, system: d.system.key, connector: d.connector, simulated: d.simulated };
}

export async function executeCapability(
  ctx: ExecutionContext,
  capabilityId: CapabilityId,
  rawInput: unknown,
  options: { authorize?: Authorizer } = {}
): Promise<CapabilityResult> {
  const contract = getCapability(capabilityId);
  if (!contract) return { ok: false, code: "unknown_capability", reason: `Unknown capability ${capabilityId}` };

  const parsed = contract.input.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "invalid_input", reason: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
  const input = parsed.data as Record<string, unknown>;
  if (contract.idempotency === "key_required" && typeof input.idempotencyKey !== "string") {
    return { ok: false, code: "idempotency_key_required", reason: `${capabilityId} requires an idempotency key` };
  }

  const resolution = await resolveCapability(ctx.businessId, capabilityId);
  if (!resolution.ok) return { ok: false, code: resolution.code, reason: resolution.reason, ...(resolution.system ? { provenance: { capability: capabilityId, systemId: resolution.system } } : {}) };
  const { descriptor, connector, mapping } = resolution;
  const provenance = provenanceOf(capabilityId, mapping.version, descriptor);

  if (contract.authority === "policy_gated") {
    if (!options.authorize) return { ok: false, code: "not_authorized", reason: `${capabilityId} changes the world and no authority decision was made`, provenance };
    const decision = await options.authorize({ capability: capabilityId, input, system: descriptor });
    if (decision.status === "denied") return { ok: false, code: "not_authorized", reason: decision.reason, provenance };
    if (decision.status === "requires_approval") return { ok: false, code: "requires_approval", reason: decision.reason, provenance };
  }

  return invokeConnector(contract, descriptor, connector, input, ctx, provenance);
}

/**
 * The post-resolution half of the contract: execute, validate the output,
 * require confirmation for consequential calls. Shared by the runtime and
 * the conformance suite so a connector is certified against exactly what
 * runs in production.
 */
export async function invokeConnector(
  contract: AnyCapabilityContract,
  descriptor: SystemDescriptor,
  connector: Connector,
  input: Record<string, unknown>,
  ctx: ExecutionContext,
  provenance: CapabilityProvenance = provenanceOf(contract.id, contract.version, descriptor)
): Promise<CapabilityResult> {
  const capabilityId = contract.id;
  if (!connector.execute) return { ok: false, code: "not_executable", reason: `${descriptor.system.name} exposes ${capabilityId} only through its typed adapter`, provenance };

  let raw: unknown;
  try {
    raw = await connector.execute(capabilityId, input, ctx);
  } catch (err) {
    return { ok: false, code: "provider_error", reason: err instanceof Error ? err.message : "system error", provenance };
  }

  const out = contract.output.safeParse(raw);
  if (!out.success) {
    // A consequential call whose confirmation is missing is UNVERIFIED, not merely malformed.
    const unverified = contract.verification === "provider_confirmed" && (raw as { verified?: unknown } | null)?.verified !== true;
    return { ok: false, code: unverified ? "unverified" : "invalid_output", reason: unverified ? `${descriptor.system.name} did not confirm ${capabilityId}` : `Output does not match ${capabilityId}@${contract.version}`, provenance };
  }
  return { ok: true, output: out.data as Record<string, unknown>, provenance };
}
