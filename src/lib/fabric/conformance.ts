import { getCapability, type CapabilityId } from "./capability";
import { invokeConnector } from "./executor";
import type { Connector, ExecutionContext } from "./registry";
import type { SystemDescriptor } from "./system";

/**
 * CAPABILITY CONFORMANCE SUITE.
 *
 *   new connector/mapping -> run the suite -> only then may the mapping be
 *   marked conformance_passed (and later activated by the owner).
 *
 * The suite drives the connector through `invokeConnector` — the same code
 * the runtime uses after resolution — and checks that the system:
 *
 *  - declares the capability it claims;
 *  - never sees input the contract rejects;
 *  - returns output that normalizes to the contract;
 *  - (consequential) confirms success explicitly, and returns the same
 *    result for the same idempotency key;
 *  - reports its own failures as failures (server error, rejected
 *    authorization) — never as success;
 *  - does not claim success it didn't confirm;
 *  - refuses capabilities it doesn't implement.
 *
 * Fault checks need a harness that can make the system fail on purpose
 * (for HTTP systems: a sandbox/mock transport). Without one they are
 * reported as `skipped`, and a report with skipped fault checks does not pass.
 * Conformance runs against a sandbox or mock — never a live system with real
 * side effects.
 */

export const CONFORMANCE_SUITE = "barry-conformance/1";

export type FaultKind = "server_error" | "unauthorized" | "unconfirmed";

export type ConformanceHarness = {
  /** Make the next calls fail in the given way; returns a function that restores normal behavior. */
  injectFault?(kind: FaultKind): () => void;
};

export type ConformanceCheck = { name: string; status: "passed" | "failed" | "skipped"; detail?: string };

export type ConformanceReport = {
  suite: string;
  capability: CapabilityId;
  system: string;
  passed: boolean;
  checks: ConformanceCheck[];
  ranAt: string;
};

export async function runConformance(input: {
  capability: CapabilityId;
  descriptor: SystemDescriptor;
  connector: Connector;
  harness?: ConformanceHarness;
  /** Overrides the contract's own example inputs. */
  validInput?: Record<string, unknown>;
  invalidInput?: unknown;
}): Promise<ConformanceReport> {
  const { capability, descriptor, connector, harness } = input;
  const checks: ConformanceCheck[] = [];
  const add = (name: string, ok: boolean | "skipped", detail?: string) => checks.push({ name, status: ok === "skipped" ? "skipped" : ok ? "passed" : "failed", ...(detail ? { detail } : {}) });
  const contract = getCapability(capability);
  const report = (): ConformanceReport => ({
    suite: CONFORMANCE_SUITE,
    capability,
    system: descriptor.system.key,
    passed: checks.length > 0 && checks.every((c) => c.status === "passed"),
    checks,
    ranAt: new Date().toISOString(),
  });
  if (!contract) {
    add("contract exists", false, `Unknown capability ${capability}`);
    return report();
  }
  const ctx: ExecutionContext = { businessId: descriptor.businessId };
  const consequential = contract.effect === "consequential";

  // 1. Declaration.
  const declared = await connector.capabilities().catch(() => [] as string[]);
  add("declares the capability", declared.includes(capability));

  // 2. Invalid input never reaches the system.
  const invalid = input.invalidInput ?? contract.examples?.invalid;
  if (invalid === undefined) add("rejects invalid input", "skipped", "no invalid example");
  else {
    let reached = false;
    const spy: Connector = { ...connector, execute: async (...args) => ((reached = true), connector.execute!(...args)) };
    const parsed = contract.input.safeParse(invalid);
    if (parsed.success) await invokeConnector(contract, descriptor, spy, parsed.data as Record<string, unknown>, ctx);
    add("rejects invalid input", !parsed.success && !reached);
  }

  // 3. Normalized output.
  const validRaw = input.validInput ?? contract.examples?.valid;
  const valid = validRaw === undefined ? undefined : contract.input.safeParse(validRaw);
  if (!valid?.success) {
    add("returns contract-shaped output", false, "no valid example input");
    return report();
  }
  const validData = valid.data as Record<string, unknown>;
  const first = await invokeConnector(contract, descriptor, connector, validData, ctx);
  add("returns contract-shaped output", first.ok, first.ok ? undefined : `${first.code}: ${first.reason}`);

  // 4. Consequential: explicit confirmation + idempotency.
  if (consequential) {
    add("confirms success explicitly", first.ok && first.output.verified === true);
    const second = await invokeConnector(contract, descriptor, connector, validData, ctx);
    add(
      "same idempotency key, same result",
      first.ok && second.ok && JSON.stringify(first.output) === JSON.stringify(second.output),
      second.ok ? undefined : `${second.code}: ${second.reason}`
    );
  }

  // 5. Failure semantics: the system's failures stay failures.
  const faults: [FaultKind, string, (r: Awaited<ReturnType<typeof invokeConnector>>) => boolean][] = [
    ["server_error", "a system error is reported as a system error", (r) => !r.ok && r.code === "provider_error"],
    ["unauthorized", "rejected authorization is reported, not hidden", (r) => !r.ok && r.code === "provider_error"],
  ];
  if (consequential) faults.push(["unconfirmed", "an unconfirmed write is never a success", (r) => !r.ok && r.code === "unverified"]);
  for (const [kind, name, expected] of faults) {
    if (!harness?.injectFault) {
      add(name, "skipped", "no fault-injection harness");
      continue;
    }
    const restore = harness.injectFault(kind);
    try {
      add(name, expected(await invokeConnector(contract, descriptor, connector, validData, ctx)));
    } finally {
      restore();
    }
  }

  // 6. Unsupported capabilities fail closed.
  const other = connector.execute ? await invokeConnector({ ...contract, id: `${capability}.__unsupported__` }, descriptor, connector, validData, ctx) : undefined;
  add("refuses capabilities it does not implement", !other || (!other.ok && other.code !== "invalid_output"));

  return report();
}
