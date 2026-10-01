import { executeCapability, type Authorizer, type CapabilityResult } from "./executor";
import type { ExecutionContext } from "./registry";
import type { CapabilityId } from "./capability";

/**
 * COMPOSITE WORKFLOW — one business workflow across several systems with ONE transaction state:
 * each step is a capability call with its own idempotency key derived from the workflow key, a
 * verified handoff (a step's validated output feeds the next), the authority decision made per step,
 * and an audit of every step. The workflow stops at the first refusal or failure; nothing is retried
 * by itself and nothing after a failed step runs.
 */

export type WorkflowStep = { name: string; capability: CapabilityId; input: (previous: Record<string, unknown>[]) => Record<string, unknown> };
export type WorkflowStepRecord = { name: string; capability: CapabilityId; idempotencyKey: string; status: "completed" | "refused" | "failed" | "not_run"; output?: Record<string, unknown>; code?: string; reason?: string; system?: string; at: string };
export type WorkflowRun = { key: string; status: "completed" | "refused" | "failed"; steps: WorkflowStepRecord[]; startedAt: string; finishedAt: string };

export async function runCompositeWorkflow(input: { ctx: ExecutionContext; key: string; steps: WorkflowStep[]; authorize: Authorizer; now?: () => Date }): Promise<WorkflowRun> {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const records: WorkflowStepRecord[] = [];
  const outputs: Record<string, unknown>[] = [];
  let status: WorkflowRun["status"] = "completed";
  for (const [i, step] of input.steps.entries()) {
    if (status !== "completed") {
      records.push({ name: step.name, capability: step.capability, idempotencyKey: `${input.key}:${i}`, status: "not_run", at: now().toISOString() });
      continue;
    }
    const idempotencyKey = `${input.key}:${i}`;
    const stepInput = { ...step.input(outputs), idempotencyKey };
    const result: CapabilityResult = await executeCapability(input.ctx, step.capability, stepInput, { authorize: input.authorize });
    if (result.ok) {
      const output = result.output as Record<string, unknown>;
      outputs.push(output);
      records.push({ name: step.name, capability: step.capability, idempotencyKey, status: "completed", output, system: result.provenance.systemId, at: now().toISOString() });
    } else {
      status = result.code === "not_authorized" || result.code === "requires_approval" ? "refused" : "failed";
      records.push({ name: step.name, capability: step.capability, idempotencyKey, status: status === "refused" ? "refused" : "failed", code: result.code, reason: result.reason, ...(result.provenance ? { system: result.provenance.systemId } : {}), at: now().toISOString() });
    }
  }
  return { key: input.key, status, steps: records, startedAt, finishedAt: now().toISOString() };
}
