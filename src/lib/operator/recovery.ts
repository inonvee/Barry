import type { PaymentRequestRecord } from "@/lib/store/types";
import type { Opportunity } from "@/lib/owner/opportunities";
import { isVerifiedPaid, type Money } from "@/lib/owner/revenue";
import type { ExecutionAttempt } from "./attempts";

/**
 * REVENUE RECOVERY — evidence-backed states for every recoverable opportunity: POTENTIAL (nothing
 * tried), ATTEMPTED (BARRY or the owner acted), RECOVERED (a later payment exists), VERIFIED (that
 * payment is provider-verified). The four never mix; test money stays apart. Pure.
 */
export type RecoveryState = "potential" | "attempted" | "recovered" | "verified";
export type RecoveryItem = { id: string; kind: Opportunity["kind"]; customer: string; conversationId: string; state: RecoveryState; amount?: number; currency?: string; simulated: boolean; evidence: string[]; attempts: number };
export type RecoverySummary = Record<RecoveryState, Money> & { simulated: Money; items: number };

const add = (m: Money, c: string | undefined, v: number | undefined) => {
  if (!c || !v) return;
  m[c] = Math.round(((m[c] ?? 0) + v) * 100) / 100;
};

export function recoveryLedger(input: { opportunities: Opportunity[]; attempts: ExecutionAttempt[]; payments: PaymentRequestRecord[] }): { items: RecoveryItem[]; summary: RecoverySummary } {
  const items: RecoveryItem[] = [];
  const summary: RecoverySummary = { potential: {}, attempted: {}, recovered: {}, verified: {}, simulated: {}, items: 0 };
  for (const o of input.opportunities) {
    if (!o.recoverable && o.kind !== "unpaid_link") continue;
    const attempts = input.attempts.filter((a) => a.obligationKey.endsWith(o.id.split(":")[1] ?? "") && a.status !== "skipped" && a.status !== "cancelled");
    const later = input.payments.filter((p) => p.conversationId === o.conversationId && p.createdAt >= o.since && (p.status === "paid"));
    const verified = later.some(isVerifiedPaid);
    const state: RecoveryState = verified ? "verified" : later.length ? "recovered" : attempts.length ? "attempted" : "potential";
    const item: RecoveryItem = { id: o.id, kind: o.kind, customer: o.customer, conversationId: o.conversationId, state, amount: o.amount, currency: o.currency, simulated: o.simulated, evidence: [...o.evidence, ...attempts.map((a) => `attempt ${a.n} ${a.status} ${a.at}`), ...later.map((p) => `payment ${p.id} ${p.status}${p.verifiedAt ? " verified" : ""}`)], attempts: attempts.length };
    items.push(item);
    summary.items += 1;
    if (o.simulated) add(summary.simulated, o.currency, o.amount);
    else add(summary[state], o.currency, o.amount);
  }
  return { items, summary };
}
