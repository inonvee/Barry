import { z } from "zod";
import { registerCapability, type AnyCapabilityContract } from "./capability";

/**
 * SHARED CAPABILITY VOCABULARY beyond BARRY's typed flows.
 *
 * Contracts any business's systems may implement. They are data — the same
 * registration a business manifest would make — and the planner, compiler
 * and runtime never name them. One definition each: tests, fixtures and
 * connectors all use these, so no two parts of BARRY can disagree about
 * what "shipping.track" takes or returns.
 */

const vocabulary = { source: "barry_core" as const, ref: "vocabulary" };

export const VOCABULARY_CAPABILITIES: AnyCapabilityContract[] = [
  {
    id: "shipping.track",
    version: "1.0.0",
    purpose: "Where is a shipment? Status and expected delivery for a tracking number.",
    input: z.object({ trackingNumber: z.string().min(3).max(64) }),
    output: z.object({ trackingNumber: z.string(), status: z.string(), eta: z.string().optional() }),
    effect: "read",
    verification: "none",
    idempotency: "none",
    authority: "none",
    provenance: vocabulary,
    examples: { valid: { trackingNumber: "TRK-1001" }, invalid: { trackingNumber: "x" } },
  },
  {
    id: "support.ticket.create",
    version: "1.0.0",
    purpose: "Open a support case in the business's helpdesk about an order, shipment or account the customer named.",
    // Identifiers only: `reference` must be something the customer or a system result stated, and
    // `reason` is one of the contract's own options — nothing a model could make up.
    input: z.object({
      reference: z.string().min(2).max(64),
      reason: z.enum(["delivery_delay", "damaged_item", "missing_item", "wrong_item", "billing", "other"]),
      idempotencyKey: z.string().min(8),
    }),
    output: z.object({ ticketId: z.string(), verified: z.literal(true) }),
    effect: "consequential",
    verification: "provider_confirmed",
    idempotency: "key_required",
    authority: "policy_gated",
    provenance: vocabulary,
    examples: {
      valid: { reference: "ORD-1001", reason: "damaged_item", idempotencyKey: "ticket-key-01" },
      invalid: { reference: "", reason: "not-a-reason", idempotencyKey: "x" },
    },
  },
];

for (const contract of VOCABULARY_CAPABILITIES) registerCapability(contract);
