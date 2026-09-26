import type { BusinessGraph } from "@/lib/business-graph";
import { getPolicy, isActionAvailable } from "@/lib/business-graph";

export type PolicyStatus = "allowed" | "allowed_within_limits" | "requires_approval" | "denied";

export type PolicyDecision = {
  status: PolicyStatus;
  reason: string;
  policyId?: string;
  /** When status is allowed_within_limits, the params BARRY should actually use. */
  adjustedParams?: Record<string, unknown>;
};

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

      if (params.discountPct && params.discountPct > 0) {
        const maxDiscount = getPolicy(graph, "max_auto_discount_pct");
        const cap = maxDiscount?.value ?? 0;
        if (params.discountPct > cap) {
          return {
            status: "requires_approval",
            reason: `Requested discount ${params.discountPct}% exceeds automatic limit of ${cap}%.`,
            policyId: "max_auto_discount_pct",
          };
        }
      }

      const maxAmount = getPolicy(graph, "max_auto_payment_amount");
      if (maxAmount && params.amount > maxAmount.value) {
        return {
          status: "requires_approval",
          reason: `Payment amount ${params.amount} exceeds automatic limit of ${maxAmount.value}.`,
          policyId: "max_auto_payment_amount",
        };
      }

      return { status: "allowed", reason: "Payment request is within policy limits." };
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
