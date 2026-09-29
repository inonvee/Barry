import crypto from "node:crypto";
import { z } from "zod";
import { defineTool, type ToolContext } from "./types";
import type { BusinessGraph } from "@/lib/business-graph";
import { getBackend } from "@/lib/store";
import { executeCapability, type CapabilityResult } from "@/lib/fabric/executor";
import { getCapability, CAPABILITY_ID } from "@/lib/fabric/capability";
import { decideCapability, type AuthorityDecision } from "@/lib/policy/authority";
import "@/lib/fabric";

/**
 * THE GENERIC CAPABILITY ACTION.
 *
 * One action for every registered capability — shipping, support, CRM,
 * procurement, anything the business's systems implement — so a new domain
 * never needs a planner branch. The model names the capability and its
 * semantic input; everything that makes it safe is here and deterministic:
 *
 *  - the capability must be registered (the model can't invent one);
 *  - input is validated by the capability's own contract;
 *  - BARRY — not the model — supplies the idempotency key, derived from the
 *    conversation and the exact call, so a repeated plan is the same call;
 *  - authority is the business's rules (decideCapability), or an owner
 *    approval that matches THIS exact call, is still valid, and still
 *    permitted by current rules;
 *  - the system is chosen by the fabric, never by the model;
 *  - a consequential call succeeds only when the system confirmed it.
 */

export const INVOKE_CAPABILITY = "invokeCapability";
const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The model's input with anything BARRY owns removed. */
export function semanticInput(input: Record<string, unknown>): Record<string, unknown> {
  const { idempotencyKey: _k, ...rest } = input;
  void _k;
  return rest;
}

/** Fingerprint of one exact call: capability + semantic input. */
export function callFingerprint(capability: string, input: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(`${capability}\n${canonical(semanticInput(input))}`).digest("hex");
}

/** Deterministic idempotency key: the same call in the same conversation is the same side effect. */
export function capabilityIdempotencyKey(ctx: Pick<ToolContext, "conversationId"> & { businessId: string }, capability: string, input: Record<string, unknown>): string {
  return `bk_${crypto.createHash("sha256").update(`${ctx.businessId}\n${ctx.conversationId}\n${callFingerprint(capability, input)}`).digest("hex").slice(0, 40)}`;
}

/**
 * Authority for one call. With an approval id, the approval must be for
 * THIS business, conversation and exact call, approved, unexpired — and
 * current rules must not have since denied it.
 */
export async function authorizeCapabilityCall(
  graph: BusinessGraph,
  ctx: ToolContext,
  capability: string,
  input: Record<string, unknown>,
  approvalId?: string
): Promise<AuthorityDecision> {
  const decision = decideCapability(graph, capability, semanticInput(input));
  if (!approvalId || decision.status !== "requires_approval") return decision;
  const approval = await getBackend().getApproval(approvalId);
  const requested = approval?.requestedInput as { capability?: string; input?: Record<string, unknown> } | undefined;
  if (!approval || approval.businessId !== graph.business.id || approval.conversationId !== ctx.conversationId || approval.requestedAction !== INVOKE_CAPABILITY) {
    return { status: "denied", reason: "The approval does not belong to this call" };
  }
  if (approval.status !== "approved") return { status: "denied", reason: `The approval is ${approval.status}` };
  if (!requested?.capability || !requested.input || callFingerprint(requested.capability, requested.input) !== callFingerprint(capability, input)) {
    return { status: "denied", reason: "The approved call differs from this one" };
  }
  if (Date.now() - Date.parse(approval.createdAt) > APPROVAL_TTL_MS) return { status: "denied", reason: "The approval has expired" };
  return { status: "allowed", reason: `Approved by ${approval.resolution?.decidedBy ?? "the owner"}`, ruleId: decision.ruleId };
}

const ResultSchema = z.object({
  capability: z.string(),
  executed: z.boolean(),
  ok: z.boolean(),
  code: z.string().optional(),
  reason: z.string().optional(),
  output: z.record(z.string(), z.unknown()).optional(),
  verified: z.boolean(),
  provenance: z.object({ system: z.string(), connector: z.string(), version: z.string(), simulated: z.boolean() }).optional(),
  authority: z.object({ status: z.string(), reason: z.string(), ruleId: z.string().optional() }),
});
export type CapabilityCallResult = z.infer<typeof ResultSchema>;

export const invokeCapability = defineTool({
  name: INVOKE_CAPABILITY,
  description: "Execute one registered capability through the business's own connected system.",
  inputSchema: z.object({
    capability: z.string().regex(CAPABILITY_ID),
    input: z.record(z.string(), z.unknown()),
    purpose: z.string().max(300),
    approvalId: z.string().optional(),
  }),
  outputSchema: ResultSchema,
  async execute(call, ctx): Promise<CapabilityCallResult> {
    const contract = getCapability(call.capability);
    const businessId = ctx.graph.business.id;
    const input: Record<string, unknown> = semanticInput(call.input);
    if (contract?.idempotency === "key_required") input.idempotencyKey = capabilityIdempotencyKey({ businessId, conversationId: ctx.conversationId }, call.capability, input);

    // Authority first — for reads too (a business may restrict them). Nothing runs without "allowed".
    const authority = await authorizeCapabilityCall(ctx.graph, ctx, call.capability, input, call.approvalId);
    if (authority.status !== "allowed") {
      return { capability: call.capability, executed: false, ok: false, code: authority.status === "denied" ? "not_authorized" : "requires_approval", reason: authority.reason, verified: false, authority };
    }
    const result: CapabilityResult = await executeCapability({ businessId, conversationId: ctx.conversationId, customerId: ctx.customerId }, call.capability, input, {
      authorize: () => authority,
    });
    if (!result.ok) {
      const executed = result.code === "provider_error" || result.code === "invalid_output" || result.code === "unverified";
      return { capability: call.capability, executed, ok: false, code: result.code, reason: result.reason, verified: false, authority };
    }
    return {
      capability: call.capability,
      executed: true,
      ok: true,
      output: result.output,
      verified: contract?.effect === "consequential" ? result.output.verified === true : false,
      provenance: { system: result.provenance.system, connector: result.provenance.connector, version: result.provenance.version, simulated: result.provenance.simulated },
      authority,
    };
  },
});
