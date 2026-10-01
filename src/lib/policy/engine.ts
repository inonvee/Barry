import { applyFounderControls, currentControls } from "@/lib/hq/controls";
import type { BusinessGraph } from "@/lib/business-graph";
import { getPolicy, isActionAvailable } from "@/lib/business-graph";
import { decideCapability } from "./authority";
import { discountPolicyOf } from "./effective-rules";

export type PolicyStatus = "allowed" | "requires_approval" | "denied";

/** Which effective rule governed a discount decision — shown verbatim in the Inspector. */
export type DiscountAuthorityTrace = {
  rule: "max_auto_discount_pct";
  effectiveMax: number;
  source: "static" | "owner_trained";
  policyId: string;
  factId?: string;
  revision: string;
  reviewer?: string;
  reviewedAt?: string;
  requested: number;
  result: PolicyStatus;
  reason: string;
};

export type PolicyDecision = {
  status: PolicyStatus;
  reason: string;
  policyId?: string;
  authority?: DiscountAuthorityTrace;
};

/**
 * MEGA RELIABILITY MISSION Part 14 audit note: an earlier version of
 * this type carried an unused `"allowed_within_limits"` status and an
 * `adjustedParams` field ("the params BARRY should actually use"
 * instead of what was requested) — but no policy branch below ever
 * produced either one. Removed rather than implemented: every existing
 * over-limit case (discount over cap, custom pricing, payment amount
 * over cap) already has a clear, tested, correct policy — escalate to
 * `requires_approval` and let a human decide — and a silent auto-cap
 * would be a WORSE design, not a missing feature: quietly substituting
 * a different discount/amount than what the customer was told, without
 * their awareness or explicit owner sign-off, is exactly the kind of
 * unverified state change this whole architecture exists to prevent.
 * If a genuine "auto-adjust within a band" policy is ever needed, it
 * should be a new, explicit, fully-tested PolicyStatus variant added
 * deliberately — not a silently-resurrected unused field.
 */

export type ActionRequest =
  | { action: "createBooking"; params: { offerId: string } }
  | { action: "createPaymentRequest"; params: { amount: number; discountPct?: number; isCustomPrice?: boolean } }
  | { action: "refund"; params: { amount: number } }
  | { action: string; params: Record<string, unknown> };

/**
 * Central authority for whether BARRY may execute an action. The runtime
 * must call this before every tool execution and may never bypass it.
 * Decisions are driven entirely by the Business Graph's policies +
 * availableActions, never by business type.
 */
export function decide(graph: BusinessGraph, request: ActionRequest): PolicyDecision {
  const base = decideByBusinessRules(graph, request);
  // The founder's controls run AFTER the business's own rules and only ever tighten them.
  const founder = applyFounderControls(currentControls(graph.business.id), request.action, request.params as Record<string, unknown>, base);
  if (founder.status === "allowed") return base;
  return { status: founder.status, reason: founder.reason, policyId: founder.policyId, ...(base.authority ? { authority: { ...base.authority, result: founder.status, reason: founder.reason } } : {}) };
}

function decideByBusinessRules(graph: BusinessGraph, request: ActionRequest): PolicyDecision {
  // The generic capability action is governed per CAPABILITY by the
  // business's authority rules — never by the action name.
  if (request.action === "invokeCapability") {
    const params = request.params as { capability?: unknown; input?: unknown };
    if (typeof params.capability !== "string" || !params.input || typeof params.input !== "object") {
      return { status: "denied", reason: "Malformed capability call" };
    }
    const d = decideCapability(graph, params.capability, params.input as Record<string, unknown>);
    return { status: d.status, reason: d.reason, ...(d.ruleId ? { policyId: d.ruleId } : {}) };
  }
  if (!isActionAvailable(graph, request.action)) {
    return { status: "denied", reason: `Action "${request.action}" is not enabled for this business.` };
  }

  switch (request.action) {
    case "createBooking": {
      const policy = getPolicy(graph, "bookings_auto_allowed");
      if (policy && !policy.value) {
        return {
          status: "requires_approval",
          reason: "Bookings require owner approval for this business.",
          policyId: "bookings_auto_allowed",
        };
      }
      return { status: "allowed", reason: "Booking creation is permitted automatically." };
    }

    case "createCommerceCheckout": {
      // A checkout sends a payment link for the cart's real total (read from
      // the provider result BARRY holds, and re-verified by the tool).
      const amount = (request.params as { amount?: number }).amount;
      const maxAmount = getPolicy(graph, "max_auto_payment_amount");
      if (maxAmount && typeof amount === "number" && amount > maxAmount.value) {
        return {
          status: "requires_approval",
          reason: `Order total ${amount} exceeds automatic limit of ${maxAmount.value}.`,
          policyId: "max_auto_payment_amount",
        };
      }
      return { status: "allowed", reason: "Checkout within the automatic payment limit." };
    }

    case "grantDiscount": {
      // A discount is granted by the business's own limit: within it BARRY may give it; above it the
      // owner decides on exactly these terms.
      const pct = (request.params as { discountPct?: number }).discountPct ?? 0;
      return discountDecision(graph, pct, `Discount ${pct}% is within the automatic limit`);
    }

    case "createPaymentRequest": {
      const params = request.params as { amount: number; discountPct?: number; isCustomPrice?: boolean };

      if (params.isCustomPrice) {
        const customPricing = getPolicy(graph, "custom_pricing_requires_approval");
        if (customPricing?.value) {
          return {
            status: "requires_approval",
            reason: "Custom pricing requires owner approval.",
            policyId: "custom_pricing_requires_approval",
          };
        }
      }

      let discountAuthority: DiscountAuthorityTrace | undefined;
      if (params.discountPct && params.discountPct > 0) {
        const d = discountDecision(graph, params.discountPct, `Discount ${params.discountPct}% is within the automatic limit`);
        if (d.status !== "allowed") return d;
        discountAuthority = d.authority;
      }

      const maxAmount = getPolicy(graph, "max_auto_payment_amount");
      if (maxAmount && params.amount > maxAmount.value) {
        return {
          status: "requires_approval",
          reason: `Payment amount ${params.amount} exceeds automatic limit of ${maxAmount.value}.`,
          policyId: "max_auto_payment_amount",
          ...(discountAuthority ? { authority: discountAuthority } : {}),
        };
      }

      return { status: "allowed", reason: "Payment request is within policy limits.", ...(discountAuthority ? { authority: discountAuthority } : {}) };
    }

    case "refund": {
      const policy = getPolicy(graph, "refund_requires_approval");
      if (policy?.value) {
        return {
          status: "requires_approval",
          reason: "Refunds require owner approval for this business.",
          policyId: "refund_requires_approval",
        };
      }
      return { status: "allowed", reason: "Refunds are permitted automatically." };
    }

    default:
      return { status: "allowed", reason: "No specific policy constrains this action." };
  }
}

/**
 * A discount is decided ONLY by the effective discount rule (static profile or the owner's approved,
 * compiled teaching — see effective-rules.ts). The decision carries that rule's provenance.
 */
function discountDecision(graph: BusinessGraph, pct: number, withinWords: string): PolicyDecision {
  const effective = discountPolicyOf(graph);
  const cap = effective?.value ?? 0;
  const p = effective?.provenance;
  const trace = (result: PolicyStatus, reason: string): DiscountAuthorityTrace => ({
    rule: "max_auto_discount_pct",
    effectiveMax: cap,
    source: p?.source ?? "static",
    policyId: effective?.policyId ?? "none",
    ...(p?.factId ? { factId: p.factId } : {}),
    revision: p?.revision ?? "static:none",
    ...(p?.reviewer ? { reviewer: p.reviewer } : {}),
    ...(p?.reviewedAt ? { reviewedAt: p.reviewedAt } : {}),
    requested: pct,
    result,
    reason,
  });
  if (pct > cap) {
    const reason = `Requested discount ${pct}% exceeds automatic limit of ${cap}%.`;
    return { status: "requires_approval", reason, policyId: "max_auto_discount_pct", authority: trace("requires_approval", reason) };
  }
  const reason = `${withinWords} of ${cap}%.`;
  return { status: "allowed", reason, authority: trace("allowed", reason) };
}
