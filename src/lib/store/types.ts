/**
 * Storage interface for everything BARRY's simulated tool adapters read and
 * write: bookings, inventory deltas, payment requests, approvals, follow-ups.
 *
 * Phase 1 ships an in-memory implementation (`memory-backend.ts`). A real
 * deployment swaps this for a Supabase-backed implementation without
 * touching the tools, policy engine, or runtime — they only depend on this
 * interface.
 */

export type BookingRecord = {
  id: string;
  businessId: string;
  offerId: string;
  resourceId: string;
  start: string;
  end: string;
  customerId: string;
  conversationId: string;
  partySize: number;
  status: "confirmed" | "cancelled";
  createdAt: string;
  provider?: "memory" | "google-calendar";
  providerEventId?: string;
  idempotencyKey?: string;
  verifiedAt?: string;
};

export type PaymentRequestRecord = {
  id: string;
  businessId: string;
  conversationId: string;
  customerId: string;
  amount: number;
  currency: string;
  reason: string;
  status: "pending" | "paid" | "failed" | "cancelled";
  createdAt: string;
};

export type ApprovalRecord = {
  id: string;
  businessId: string;
  conversationId: string;
  customerId: string;
  requestedAction: string;
  requestedInput: unknown;
  reason: string;
  policyId: string;
  proposedValue?: unknown;
  status: "pending" | "approved" | "declined";
  resolution?: {
    decision: "approved" | "declined";
    alternateValue?: unknown;
    decidedAt: string;
    decidedBy: string;
  };
  createdAt: string;
};

export type FollowUpRecord = {
  id: string;
  businessId: string;
  conversationId: string;
  customerId: string;
  reason: string;
  dueAt: string;
  status: "scheduled" | "sent" | "cancelled";
  createdAt: string;
};

export interface BarryBackend {
  // Availability / bookings
  listBookings(businessId: string): Promise<BookingRecord[]>;
  createBooking(record: Omit<BookingRecord, "id" | "createdAt" | "status">): Promise<BookingRecord>;

  // Inventory
  getInventory(businessId: string, sku: string, baseQuantity: number): Promise<number>;
  /**
   * Atomically reserve `quantity` units against `baseQuantity` of stock —
   * returns false (and reserves NOTHING) if doing so would oversell.
   * `baseQuantity` must be supplied on every call (never cached from an
   * earlier checkInventory) since availability can change between when a
   * customer's stock was checked and when their order actually fulfills.
   */
  decrementInventory(businessId: string, sku: string, quantity: number, baseQuantity: number): Promise<boolean>;

  // Payments
  createPaymentRequest(
    record: Omit<PaymentRequestRecord, "id" | "createdAt" | "status">
  ): Promise<PaymentRequestRecord>;
  getPaymentRequest(id: string): Promise<PaymentRequestRecord | undefined>;
  simulatePaymentOutcome(id: string, outcome: "paid" | "failed"): Promise<PaymentRequestRecord>;

  // Approvals
  createApproval(
    record: Omit<ApprovalRecord, "id" | "createdAt" | "status">
  ): Promise<ApprovalRecord>;
  getApproval(id: string): Promise<ApprovalRecord | undefined>;
  listApprovals(businessId: string): Promise<ApprovalRecord[]>;
  resolveApproval(
    id: string,
    decision: "approved" | "declined",
    decidedBy: string,
    alternateValue?: unknown
  ): Promise<ApprovalRecord>;

  // Follow-ups
  createFollowUp(record: Omit<FollowUpRecord, "id" | "createdAt" | "status">): Promise<FollowUpRecord>;
  listFollowUps(businessId: string): Promise<FollowUpRecord[]>;
}
