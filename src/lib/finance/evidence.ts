import { z } from "zod";
import { getBackend } from "@/lib/store";
import type { OperatorRecord } from "@/lib/store/types";
import type { CostEvidence } from "./impact";

/**
 * NORMALIZED COST EVIDENCE — provider-independent records of costs the business bore or is exposed
 * to, each with source system + reference, time, currency, business, category and verification. The
 * store accepts only well-formed records; `verified` is set by the system that holds the cost (or by
 * an owner-approved statement), never inferred.
 */

export const CostEvidenceSchema = z.object({
  id: z.string().min(1).max(120),
  businessId: z.string().min(1),
  kind: z.enum(["supplier_cost", "payment_fee", "shipping_fulfillment", "saas_subscription", "discount", "return", "inventory_carrying", "deposit_no_show", "other_operating_cost"]),
  amount: z.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  at: z.string().datetime(),
  source: z.object({ system: z.string().min(1).max(80), reference: z.string().min(1).max(120) }),
  verified: z.boolean(),
  exposure: z.boolean().optional(),
  note: z.string().max(300).optional(),
  category: z.string().max(80).optional(),
  counterparty: z.string().max(120).optional(),
  item: z.string().max(120).optional(),
  unitPrice: z.number().positive().optional(),
  quantity: z.number().positive().optional(),
  orderId: z.string().max(120).optional(),
  period: z.object({ start: z.string().datetime(), end: z.string().datetime() }).optional(),
});

export function validateCostEvidence(raw: unknown): { ok: true; evidence: CostEvidence } | { ok: false; problems: string[] } {
  const parsed = CostEvidenceSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "evidence"}: ${i.message}`) };
  return { ok: true, evidence: parsed.data };
}

export async function recordCostEvidence(businessId: string, items: unknown[]): Promise<{ stored: CostEvidence[]; rejected: { index: number; problems: string[] }[] }> {
  const stored: CostEvidence[] = [];
  const rejected: { index: number; problems: string[] }[] = [];
  for (const [index, raw] of items.entries()) {
    const v = validateCostEvidence(raw);
    if (!v.ok) {
      rejected.push({ index, problems: v.problems });
      continue;
    }
    if (v.evidence.businessId !== businessId) {
      rejected.push({ index, problems: ["businessId does not match the scope"] });
      continue;
    }
    await getBackend().upsertOperatorRecord({ businessId, kind: "cost_evidence", key: v.evidence.id, data: v.evidence });
    stored.push(v.evidence);
  }
  return { stored, rejected };
}

export async function listCostEvidence(businessId: string): Promise<CostEvidence[]> {
  const records = await getBackend().listOperatorRecords(businessId, "cost_evidence");
  return records.map((r: OperatorRecord) => r.data as unknown as CostEvidence).filter((e) => e && typeof e.amount === "number").sort((a, b) => a.at.localeCompare(b.at));
}
