/**
 * The obligation MODEL (types, states, next-move words): pure, importable by client components. The
 * derivation and durable reconciliation live in ./obligations (server only).
 */

export type ObligationKind =
  | "unpaid_payment_followup"
  | "approval_blocking_transaction"
  | "held_request_recheck"
  | "unresolved_handoff"
  | "failed_action_recovery"
  | "undelivered_reply"
  | "booking_deposit_missing";

/** watching → (scheduled | actionable | waiting_on_owner | waiting_on_customer | blocked) → completed | cancelled | superseded */
export type ObligationStatus = "watching" | "scheduled" | "actionable" | "waiting_on_owner" | "waiting_on_customer" | "blocked" | "completed" | "cancelled" | "superseded";

export type NextMove = "barry_can_act" | "needs_owner" | "waiting_on_customer" | "blocked_by_capability" | "scheduled_for_later";

export const OPEN_STATUSES: ObligationStatus[] = ["watching", "scheduled", "actionable", "waiting_on_owner", "waiting_on_customer", "blocked"];

export type Obligation = {
  /** Idempotency key: `${kind}:${source record id}` — one obligation per condition, ever. */
  key: string;
  businessId: string;
  kind: ObligationKind;
  /** The record this stands on ("payment request pay_x", "approval appr_y", ...). */
  source: string;
  evidence: string[];
  conversationId: string;
  customer: string;
  /** What it is about, in owner words. */
  subject: string;
  reason: string;
  desiredOutcome: string;
  nextAction: string;
  nextMove: NextMove;
  owner: "barry" | "owner" | "customer" | "barry_team";
  eligibleAt: string;
  dueAt?: string;
  status: ObligationStatus;
  authority: "none" | "owner_approval";
  approvalId?: string;
  capability?: string;
  amount?: number;
  currency?: string;
  simulated?: boolean;
  createdAt: string;
  updatedAt: string;
  completion?: { at: string; evidence: string };
  cancellation?: { at: string; reason: string };
  supersededBy?: string;
};


export const NEXT_MOVE_WORDS: Record<NextMove, string> = {
  barry_can_act: "BARRY can act",
  needs_owner: "Needs you",
  waiting_on_customer: "Waiting on the customer",
  blocked_by_capability: "Blocked by a capability",
  scheduled_for_later: "Scheduled for later",
};

export function isOpen(o: Obligation): boolean {
  return OPEN_STATUSES.includes(o.status);
}
