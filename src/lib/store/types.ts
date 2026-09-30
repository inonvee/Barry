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
  provider?: string;
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
  provider?: string;
  providerPaymentId?: string;
  providerCheckoutUrl?: string;
  idempotencyKey?: string;
  verifiedAt?: string;
  providerEventId?: string;
  /** The provider's real transaction identifier, recorded only once the provider has actually reported one (never the payment-page/link id). */
  providerTransactionId?: string;
  /** What exactly this money pays for. An order may only be created while the thing it's bound to is unchanged. */
  binding?: PaymentBinding;
};

export type PaymentBinding = {
  kind: "commerce_cart";
  cartId: string;
  snapshotHash: string;
  amount: number;
  currency: string;
};

/**
 * The domain a connection is registered under. Open-ended: "payments",
 * "commerce", "shipping", "procurement", or any domain a business needs —
 * what the system can actually do is its capability mapping (src/lib/fabric).
 */
export type ConnectionCapability = string;
export type ConnectionStatus = "connected" | "disconnected" | "error";

export type ConnectionRecord = {
  id: string;
  businessId: string;
  capability: ConnectionCapability;
  provider: string;
  status: ConnectionStatus;
  config: Record<string, unknown>;
  credentialsRef: string;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
};

/** Owner-approved learning run over explicit sources. */
export type LearningRunStatus = "fetching" | "extracting" | "needs_owner" | "ready" | "failed";
export type LearningRunRecord = {
  id: string;
  businessId: string;
  status: LearningRunStatus;
  approvedSources: { url: string; approvedBy: string; approvedAt: string }[];
  /** Fetch outcomes, learner used, rejected candidates with reasons — never raw page content. */
  summary: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type LearnedFactClassification = "fact" | "inference" | "recommendation" | "policy";
export type LearnedFactStatus = "candidate" | "verified" | "corrected" | "rejected";
export type LearnedFactSource =
  | { kind: "web"; url: string; title?: string; quote: string }
  | { kind: "owner" };

export type LearnedFactRecord = {
  id: string;
  businessId: string;
  runId?: string;
  key: string;
  value: string;
  classification: LearnedFactClassification;
  source: LearnedFactSource;
  confidence: "low" | "medium" | "high";
  status: LearnedFactStatus;
  /** True only once the owner verified, corrected, or supplied it. */
  ownerVerified: boolean;
  /** The learned value the owner replaced, kept for audit. */
  correctedFrom?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  discoveredAt: string;
  refreshedAt: string;
};

export type OperatingStrategyRecord = {
  id: string;
  businessId: string;
  strategy: Record<string, unknown>;
  readiness: Record<string, unknown>;
  generatedAt: string;
};

export type CommerceCartRecord = {
  id: string;
  businessId: string;
  conversationId: string;
  customerId: string;
  cartId: string;
  status: "open" | "checkout" | "ordered";
  data: unknown;
  createdAt: string;
  updatedAt: string;
};

export type CommerceOrderRecord = {
  id: string;
  businessId: string;
  conversationId: string;
  customerId: string;
  orderId: string;
  cartId: string;
  totalAmount: number;
  currency: string;
  status: "created" | "paid" | "fulfilled" | "cancelled";
  idempotencyKey: string;
  verifiedAt: string;
  data: unknown;
  createdAt: string;
};

export type PaymentWebhookEventStatus = "received" | "processing" | "completed" | "failed";

export type PaymentWebhookEventRecord = {
  provider: string;
  providerEventId: string;
  paymentRequestId: string;
  status: PaymentWebhookEventStatus;
  attempts: number;
  receivedAt: string;
  processedAt?: string;
  lastError?: string;
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
  listPaymentRequests(businessId: string): Promise<PaymentRequestRecord[]>;
  findPaymentRequestByIdempotencyKey(businessId: string, idempotencyKey: string): Promise<PaymentRequestRecord | undefined>;
  findPaymentRequestByProviderPaymentId(provider: string, providerPaymentId: string): Promise<PaymentRequestRecord | undefined>;
  updatePaymentRequestStatus(
    id: string,
    status: PaymentRequestRecord["status"],
    metadata?: { verifiedAt?: string; providerEventId?: string; providerTransactionId?: string }
  ): Promise<PaymentRequestRecord>;
  recordPaymentWebhookEvent(
    provider: string,
    providerEventId: string,
    paymentRequestId: string
  ): Promise<PaymentWebhookEventRecord>;
  markPaymentWebhookEventCompleted(
    provider: string,
    providerEventId: string,
    paymentRequestId: string
  ): Promise<PaymentWebhookEventRecord>;
  markPaymentWebhookEventFailed(
    provider: string,
    providerEventId: string,
    paymentRequestId: string,
    error: string
  ): Promise<PaymentWebhookEventRecord>;
  simulatePaymentOutcome(id: string, outcome: "paid" | "failed"): Promise<PaymentRequestRecord>;

  // Business connections
  getBusinessConnection(
    businessId: string,
    capability: ConnectionCapability
  ): Promise<ConnectionRecord | undefined>;
  upsertBusinessConnection(
    record: Omit<ConnectionRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<ConnectionRecord>;
  listBusinessConnections(businessId: string): Promise<ConnectionRecord[]>;

  // Learn Business
  createLearningRun(record: Omit<LearningRunRecord, "id" | "createdAt" | "updatedAt">): Promise<LearningRunRecord>;
  updateLearningRun(id: string, patch: Partial<Pick<LearningRunRecord, "status" | "summary">>): Promise<LearningRunRecord>;
  getLatestLearningRun(businessId: string): Promise<LearningRunRecord | undefined>;
  listLearnedFacts(businessId: string): Promise<LearnedFactRecord[]>;
  /** One row per (businessId, key). */
  upsertLearnedFact(record: Omit<LearnedFactRecord, "id">): Promise<LearnedFactRecord>;
  saveOperatingStrategy(record: Omit<OperatingStrategyRecord, "id" | "generatedAt">): Promise<OperatingStrategyRecord>;
  getLatestOperatingStrategy(businessId: string): Promise<OperatingStrategyRecord | undefined>;

  // Commerce
  listCommerceCarts(businessId: string): Promise<CommerceCartRecord[]>;
  upsertCommerceCart(
    record: Omit<CommerceCartRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<CommerceCartRecord>;
  listCommerceOrders(businessId: string): Promise<CommerceOrderRecord[]>;
  createCommerceOrder(
    record: Omit<CommerceOrderRecord, "id" | "createdAt">
  ): Promise<CommerceOrderRecord>;

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

/** Resolving an approval that is no longer pending (already approved/declined/withdrawn/superseded). */
export class ApprovalAlreadyResolvedError extends Error {
  constructor(readonly approvalId: string) {
    super(`Approval ${approvalId} is no longer pending`);
    this.name = "ApprovalAlreadyResolvedError";
  }
}
