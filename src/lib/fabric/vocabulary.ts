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

// ── CAPABILITY ONTOLOGY (more reusable domains; reads unless stated) ───────────────────────────────
const readLike = { effect: "read" as const, verification: "none" as const, idempotency: "none" as const, authority: "none" as const, provenance: vocabulary, version: "1.0.0" };
const writeLike = { effect: "consequential" as const, verification: "provider_confirmed" as const, idempotency: "key_required" as const, authority: "policy_gated" as const, provenance: vocabulary, version: "1.0.0" };
const ref = z.string().min(1).max(120);
export const ONTOLOGY_CAPABILITIES: AnyCapabilityContract[] = [
  { id: "crm.contact.lookup", purpose: "Find a customer record by a verified identifier the customer gave.", input: z.object({ identifier: ref }), output: z.object({ found: z.boolean(), contactId: z.string().optional() }), examples: { valid: { identifier: "phone:972500000001" }, invalid: { identifier: "" } }, ...readLike },
  { id: "inventory.level.read", purpose: "Read the stock level of an item in a warehouse system.", input: z.object({ sku: ref }), output: z.object({ available: z.number().int().nonnegative() }), examples: { valid: { sku: "SKU-1" }, invalid: { sku: "" } }, ...readLike },
  { id: "shipping.rate.quote", purpose: "Quote shipping options for a destination and parcel.", input: z.object({ destination: ref, weightGrams: z.number().int().positive().optional() }), output: z.object({ options: z.array(z.object({ service: z.string(), amount: z.number(), currency: z.string() })) }), examples: { valid: { destination: "Haifa" }, invalid: { destination: "" } }, ...readLike },
  { id: "shipping.shipment.create", purpose: "Create a shipment for an order with the carrier.", input: z.object({ orderReference: ref, service: ref, idempotencyKey: z.string().min(8) }), output: z.object({ trackingNumber: z.string(), verified: z.literal(true) }), examples: { valid: { orderReference: "ORD-1", service: "standard", idempotencyKey: "ship-key-01" }, invalid: { orderReference: "", idempotencyKey: "x" } }, ...writeLike },
  { id: "accounting.invoice.read", purpose: "Read an invoice the accounting system issued.", input: z.object({ invoiceReference: ref }), output: z.object({ status: z.string(), amount: z.number(), currency: z.string() }), examples: { valid: { invoiceReference: "INV-1" }, invalid: { invoiceReference: "" } }, ...readLike },
  { id: "documents.file.read", purpose: "Read an owner-approved document's text.", input: z.object({ sourceId: ref }), output: z.object({ text: z.string() }), examples: { valid: { sourceId: "document:policy" }, invalid: { sourceId: "" } }, ...readLike },
  { id: "procurement.purchase_order.read", purpose: "Read a purchase order and its lines from the procurement system.", input: z.object({ purchaseOrderReference: ref }), output: z.object({ status: z.string(), lines: z.array(z.object({ item: z.string(), quantity: z.number(), unitPrice: z.number().optional() })) }), examples: { valid: { purchaseOrderReference: "PO-1" }, invalid: { purchaseOrderReference: "" } }, ...readLike },
  { id: "identity.customer.verify", purpose: "Verify a customer identifier with the identity provider (returns whether it is verified).", input: z.object({ identifier: ref }), output: z.object({ verified: z.boolean() }), examples: { valid: { identifier: "phone:972500000001" }, invalid: { identifier: "" } }, ...readLike },
  { id: "analytics.metric.read", purpose: "Read one named metric for a period from the analytics system.", input: z.object({ metric: ref, period: z.string().max(40) }), output: z.object({ value: z.number(), unit: z.string().optional() }), examples: { valid: { metric: "sessions", period: "7d" }, invalid: { metric: "", period: "" } }, ...readLike },
  { id: "support.ticket.status", purpose: "Read the status of a support case the customer referenced.", input: z.object({ ticketId: ref }), output: z.object({ status: z.string(), updatedAt: z.string().optional() }), examples: { valid: { ticketId: "T-1001" }, invalid: { ticketId: "" } }, ...readLike },
];

for (const contract of [...VOCABULARY_CAPABILITIES, ...ONTOLOGY_CAPABILITIES]) registerCapability(contract);
