import type { Money } from "@/lib/owner/revenue";

/**
 * THE INITIATIVE (pure, client-safe) — something BARRY noticed in the business's own records that the
 * owner would want to know or improve, with the evidence that proves it.
 *
 *   NO INSIGHT WITHOUT EVIDENCE: every initiative carries references to the exact records it counts
 *   (conversations, turns, approvals, obligations, payments, orders, cost records). Numbers in the
 *   observation are recomputed from those references at verification time — never model output.
 *
 *   A SCAN QUOTA IS NOT A NOTIFICATION QUOTA: scans may run 2–3 times a business-local day; an empty
 *   scan is a successful scan. Nothing is produced to fill a slot.
 *
 *   AN INITIATIVE IS NOT PERMISSION: "Do this" runs the recommended command through the normal owner
 *   command service (plan entitlement → authority → final-write gate → verification → idempotency).
 *
 * Lifecycle:
 *   (candidate) → verified → surfaced → reviewed → accepted | dismissed | snoozed → acting → measured
 *   plus: resolved (the evidence went away on its own) · invalidated (failed re-verification / owner said wrong)
 */

export type InitiativeCategory = "sales_friction" | "abandoned_demand" | "owner_friction" | "customer_experience" | "money_leakage" | "cost_margin";

export type InitiativeState = "verified" | "surfaced" | "reviewed" | "accepted" | "acting" | "measured" | "dismissed" | "snoozed" | "resolved" | "invalidated";

export type EvidenceKind = "conversation" | "turn" | "approval" | "obligation" | "payment" | "order" | "cost_record" | "operation";

/** A reference to one trusted business record (ids only — no private message text). */
export type EvidenceRef = { kind: EvidenceKind; id: string; at?: string };

/**
 * External evidence (research boundary, V1: no connector). A public claim or benchmark is NEVER a
 * verified business fact and can never produce a realised saving.
 */
export type ExternalEvidence = {
  sourceUrl: string;
  sourceType: "supplier_site" | "marketplace" | "benchmark" | "public_dataset" | "other";
  retrievedAt: string;
  claim: string;
  confidence: "low" | "medium" | "high";
  claimType: "public_claim" | "benchmark";
};

export type Importance = "high" | "medium" | "low";
export type ImpactType = "revenue_at_risk" | "recoverable_demand" | "conversion" | "owner_time" | "customer_experience" | "cost_increase" | "evidence_needed";

export type Initiative = {
  id: string;
  businessId: string;
  category: InitiativeCategory;
  /** The detector that found it (stable id). */
  detector: string;
  /** What it is about: a knowledge topic, a product, a workflow, a request type, a cost kind. */
  subject: string;
  title: string;
  /** The concise owner-facing observation (counts recomputed from evidence). */
  observation: string;
  /** Plain-language note on how solid this is ("Counted from 7 conversations in the last 7 days"). */
  basis: string;
  evidence: EvidenceRef[];
  external?: ExternalEvidence[];
  /** The aggregate the observation states (for change detection and ranking). */
  metric: { count: number; total?: number; amount?: Money; rate?: number };
  provenance: { scanId: string; detectedAt: string; window: { from: string; to: string; label: string }; localDate: string; timezone: string };
  confidence: "high" | "medium" | "low";
  importance: Importance;
  impact: { type: ImpactType; amount?: Money; note?: string };
  recommendation: { text: string; action?: { kind: "command"; command: string; label: string } | { kind: "link"; href: string; label: string } };
  /** What BARRY could do about it (if anything) and whether the plan includes that. */
  requiredFeature?: string;
  entitlement: "included" | "not_included" | "not_needed";
  /** Who decides: BARRY can act within the owner's rules, or the owner must act. */
  authority: "owner_decides" | "within_owner_rules" | "owner_only";
  canAct: boolean;
  ownerActionNeeded: boolean;
  /** Something is already being done about it (e.g. an operation running). */
  alreadyHandled?: boolean;
  testData?: boolean;
  fingerprint: string;
  state: InitiativeState;
  rank: number;
  firstSeenAt: string;
  lastSeenAt: string;
  surfacedAt?: string;
  reviewedAt?: string;
  decidedAt?: string;
  snoozedUntil?: string;
  dismissal?: { at: string; metric: Initiative["metric"] };
  resolvedAt?: string;
  invalidated?: { at: string; reason: string };
  result?: { commandId?: string; operationId?: string; startedAt?: string; measuredAt?: string; verifiedValue?: Money; verifiedSavings?: Money; note?: string };
  scans: number;
};

/** The owner-safe view (no internal rank number). */
export type InitiativeView = Omit<Initiative, "rank" | "fingerprint"> & { importanceWords: string };

export const IMPORTANCE_WORDS: Record<Importance, string> = { high: "Worth acting on soon", medium: "Worth a look", low: "For when you have a minute" };

export const OPEN_STATES: InitiativeState[] = ["verified", "surfaced", "reviewed", "accepted"];
export const isOpenInitiative = (i: Pick<Initiative, "state">) => OPEN_STATES.includes(i.state);

export function toView(i: Initiative): InitiativeView {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { rank, fingerprint, ...rest } = i;
  return { ...rest, importanceWords: IMPORTANCE_WORDS[i.importance] };
}

/** "I noticed something worth looking at…" — the same initiative as an owner message (WhatsApp brief compatible; not sent here). */
export function initiativeMessage(i: Pick<Initiative, "title" | "observation" | "recommendation" | "basis">): { text: string; actions?: { id: string; title: string }[] } {
  return { text: `I noticed something worth looking at.\n\n${i.observation}\n${i.basis}\n\n${i.recommendation.text}` };
}

/** Is the new evidence materially different from what the owner dismissed? (grew by half, or by 5+) */
export function materiallyNew(before: Initiative["metric"], now: Initiative["metric"]): boolean {
  if (now.count >= before.count + 5 || now.count >= Math.ceil(before.count * 1.5)) return true;
  const sum = (m?: Money) => Object.values(m ?? {}).reduce((s, v) => s + v, 0);
  const a = sum(before.amount);
  const b = sum(now.amount);
  return a > 0 && b >= a * 1.5;
}
