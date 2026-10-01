import type { BusinessGraph } from "@/lib/business-graph";
import type { ObligationKind } from "./obligation-model";

/**
 * FOLLOW-UP POLICIES — generic rules for what BARRY may do on its own and how often: unpaid payment
 * links, abandoned checkouts, unresolved handoffs (a nudge to the team, never to the customer on the
 * team's behalf), appointment reminders, retryable failed actions. The Genome / owner playbook defines
 * allowed, timing, attempts and escalation; BARRY's defaults are bounded. No spam: hard attempt limits
 * and minimum intervals are enforced by the executor, never by the model.
 */

export type FollowUpRule = { enabled: boolean; afterHours: number; maxAttempts: number; intervalHours: number };
export type FollowUpKind = "unpaidPayment" | "abandonedCheckout" | "unresolvedHandoff" | "appointmentReminder" | "failedAction";
export type FollowUpPolicy = Record<FollowUpKind, FollowUpRule>;

export const DEFAULT_FOLLOW_UP_POLICY: FollowUpPolicy = {
  unpaidPayment: { enabled: true, afterHours: 24, maxAttempts: 2, intervalHours: 48 },
  abandonedCheckout: { enabled: true, afterHours: 4, maxAttempts: 1, intervalHours: 72 },
  unresolvedHandoff: { enabled: true, afterHours: 4, maxAttempts: 1, intervalHours: 24 },
  appointmentReminder: { enabled: true, afterHours: 0, maxAttempts: 1, intervalHours: 24 },
  failedAction: { enabled: true, afterHours: 0, maxAttempts: 1, intervalHours: 1 },
};

export const OBLIGATION_FOLLOW_UP: Partial<Record<ObligationKind, FollowUpKind>> = {
  unpaid_payment_followup: "unpaidPayment",
  abandoned_checkout_recovery: "abandonedCheckout",
  unresolved_handoff: "unresolvedHandoff",
  appointment_reminder: "appointmentReminder",
  failed_action_recovery: "failedAction",
};

/** The effective policy: the playbook's explicit rules over bounded defaults (never beyond the caps). */
export function followUpPolicyFor(graph: Pick<BusinessGraph, "playbook">): FollowUpPolicy {
  const declared = graph.playbook.followUp ?? {};
  const out = { ...DEFAULT_FOLLOW_UP_POLICY };
  for (const kind of Object.keys(DEFAULT_FOLLOW_UP_POLICY) as FollowUpKind[]) {
    const d = declared[kind];
    if (!d) continue;
    const base = DEFAULT_FOLLOW_UP_POLICY[kind];
    out[kind] = { enabled: d.enabled, afterHours: d.afterHours ?? base.afterHours, maxAttempts: Math.min(d.maxAttempts ?? base.maxAttempts, 5), intervalHours: Math.max(d.intervalHours ?? base.intervalHours, 1) };
  }
  return out;
}

export function ruleFor(policy: FollowUpPolicy, kind: ObligationKind): FollowUpRule | undefined {
  const k = OBLIGATION_FOLLOW_UP[kind];
  return k ? policy[k] : undefined;
}
