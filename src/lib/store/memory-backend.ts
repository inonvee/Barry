import type {
  ApprovalRecord,
  BarryBackend,
  BookingRecord,
  ConnectionCapability,
  ConnectionRecord,
  CommerceCartRecord,
  CommerceOrderRecord,
  FollowUpRecord,
  PaymentWebhookEventRecord,
  PaymentRequestRecord,
} from "./types";

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * Simple process-memory implementation of BarryBackend. Good enough for the
 * simulator and tests within a single server process. Not durable across
 * serverless cold starts — swap in a Supabase-backed implementation of
 * BarryBackend for production without changing any caller.
 */
export class MemoryBackend implements BarryBackend {
  private bookings: BookingRecord[] = [];
  private inventoryDeltas = new Map<string, number>(); // `${businessId}:${sku}` -> consumed qty
  private paymentRequests = new Map<string, PaymentRequestRecord>();
  private paymentWebhookEvents = new Map<string, PaymentWebhookEventRecord>();
  private businessConnections = new Map<string, ConnectionRecord>();
  private commerceCarts = new Map<string, CommerceCartRecord>();
  private commerceOrders = new Map<string, CommerceOrderRecord>();
  private approvals = new Map<string, ApprovalRecord>();
  private followUps: FollowUpRecord[] = [];

  async listBookings(businessId: string) {
    return this.bookings.filter((b) => b.businessId === businessId && b.status === "confirmed");
  }

  async createBooking(record: Omit<BookingRecord, "id" | "createdAt" | "status">) {
    const booking: BookingRecord = {
      ...record,
      id: id("booking"),
      status: "confirmed",
      createdAt: new Date().toISOString(),
    };
    this.bookings.push(booking);
    return booking;
  }

  async getInventory(businessId: string, sku: string, baseQuantity: number) {
    const consumed = this.inventoryDeltas.get(`${businessId}:${sku}`) ?? 0;
    return Math.max(0, baseQuantity - consumed);
  }

  async decrementInventory(businessId: string, sku: string, quantity: number, baseQuantity: number) {
    const key = `${businessId}:${sku}`;
    const consumed = this.inventoryDeltas.get(key) ?? 0;
    if (consumed + quantity > baseQuantity) return false;
    this.inventoryDeltas.set(key, consumed + quantity);
    return true;
  }

  async createPaymentRequest(record: Omit<PaymentRequestRecord, "id" | "createdAt" | "status">) {
    const pr: PaymentRequestRecord = {
      ...record,
      id: id("pay"),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.paymentRequests.set(pr.id, pr);
    return pr;
  }

  async getPaymentRequest(paymentId: string) {
    return this.paymentRequests.get(paymentId);
  }

  async listPaymentRequests(businessId: string) {
    return [...this.paymentRequests.values()].filter((p) => p.businessId === businessId);
  }

  async findPaymentRequestByIdempotencyKey(businessId: string, idempotencyKey: string) {
    return [...this.paymentRequests.values()].find(
      (p) => p.businessId === businessId && p.idempotencyKey === idempotencyKey
    );
  }

  async findPaymentRequestByProviderPaymentId(provider: string, providerPaymentId: string) {
    return [...this.paymentRequests.values()].find(
      (p) => p.provider === provider && p.providerPaymentId === providerPaymentId
    );
  }

  async updatePaymentRequestStatus(
    paymentId: string,
    status: PaymentRequestRecord["status"],
    metadata: { verifiedAt?: string; providerEventId?: string } = {}
  ) {
    const pr = this.paymentRequests.get(paymentId);
    if (!pr) throw new Error(`Payment request ${paymentId} not found`);
    if (pr.status === "paid" && status !== "paid") return pr;
    pr.status = status;
    pr.verifiedAt = metadata.verifiedAt ?? pr.verifiedAt;
    pr.providerEventId = metadata.providerEventId ?? pr.providerEventId;
    this.paymentRequests.set(paymentId, pr);
    return pr;
  }

  async recordPaymentWebhookEvent(provider: string, providerEventId: string, paymentRequestId: string) {
    const key = `${provider}:${providerEventId}`;
    const existing = this.paymentWebhookEvents.get(key);
    if (existing) {
      if (existing.paymentRequestId !== paymentRequestId) throw new Error("Payment webhook event/payment mismatch");
      existing.attempts += 1;
      if (existing.status !== "completed") existing.status = "processing";
      this.paymentWebhookEvents.set(key, existing);
      return existing;
    }
    const event: PaymentWebhookEventRecord = {
      provider,
      providerEventId,
      paymentRequestId,
      status: "processing",
      attempts: 1,
      receivedAt: new Date().toISOString(),
    };
    this.paymentWebhookEvents.set(key, event);
    return event;
  }

  async markPaymentWebhookEventCompleted(provider: string, providerEventId: string, paymentRequestId: string) {
    const key = `${provider}:${providerEventId}`;
    const event =
      this.paymentWebhookEvents.get(key) ??
      ({
        provider,
        providerEventId,
        paymentRequestId,
        status: "received",
        attempts: 0,
        receivedAt: new Date().toISOString(),
      } satisfies PaymentWebhookEventRecord);
    if (event.paymentRequestId !== paymentRequestId) throw new Error("Payment webhook event/payment mismatch");
    event.status = "completed";
    event.processedAt = new Date().toISOString();
    event.lastError = undefined;
    this.paymentWebhookEvents.set(key, event);
    return event;
  }

  async markPaymentWebhookEventFailed(
    provider: string,
    providerEventId: string,
    paymentRequestId: string,
    error: string
  ) {
    const key = `${provider}:${providerEventId}`;
    const event =
      this.paymentWebhookEvents.get(key) ??
      ({
        provider,
        providerEventId,
        paymentRequestId,
        status: "received",
        attempts: 0,
        receivedAt: new Date().toISOString(),
      } satisfies PaymentWebhookEventRecord);
    if (event.paymentRequestId !== paymentRequestId) throw new Error("Payment webhook event/payment mismatch");
    event.status = "failed";
    event.lastError = error;
    this.paymentWebhookEvents.set(key, event);
    return event;
  }

  async simulatePaymentOutcome(paymentId: string, outcome: "paid" | "failed") {
    const pr = this.paymentRequests.get(paymentId);
    if (!pr) throw new Error(`Payment request ${paymentId} not found`);
    return this.updatePaymentRequestStatus(paymentId, outcome, { verifiedAt: new Date().toISOString() });
  }

  async getBusinessConnection(businessId: string, capability: ConnectionCapability) {
    return this.businessConnections.get(`${businessId}:${capability}`);
  }

  async upsertBusinessConnection(record: Omit<ConnectionRecord, "id" | "createdAt" | "updatedAt">) {
    const key = `${record.businessId}:${record.capability}`;
    const existing = this.businessConnections.get(key);
    const now = new Date().toISOString();
    const connection: ConnectionRecord = {
      ...record,
      id: existing?.id ?? id("conn"),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.businessConnections.set(key, connection);
    return connection;
  }

  async listCommerceCarts(businessId: string) {
    return [...this.commerceCarts.values()].filter((cart) => cart.businessId === businessId);
  }

  async upsertCommerceCart(record: Omit<CommerceCartRecord, "id" | "createdAt" | "updatedAt">) {
    const existing = [...this.commerceCarts.values()].find((cart) => cart.businessId === record.businessId && cart.cartId === record.cartId);
    const now = new Date().toISOString();
    const cart: CommerceCartRecord = {
      ...record,
      id: existing?.id ?? id("ccart"),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.commerceCarts.set(cart.id, cart);
    return cart;
  }

  async listCommerceOrders(businessId: string) {
    return [...this.commerceOrders.values()].filter((order) => order.businessId === businessId);
  }

  async createCommerceOrder(record: Omit<CommerceOrderRecord, "id" | "createdAt">) {
    const existing = [...this.commerceOrders.values()].find((order) => order.businessId === record.businessId && order.idempotencyKey === record.idempotencyKey);
    if (existing) return existing;
    const order: CommerceOrderRecord = { ...record, id: id("corder"), createdAt: new Date().toISOString() };
    this.commerceOrders.set(order.id, order);
    return order;
  }

  async createApproval(record: Omit<ApprovalRecord, "id" | "createdAt" | "status">) {
    const approval: ApprovalRecord = {
      ...record,
      id: id("appr"),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.approvals.set(approval.id, approval);
    return approval;
  }

  async getApproval(approvalId: string) {
    return this.approvals.get(approvalId);
  }

  async listApprovals(businessId: string) {
    return [...this.approvals.values()].filter((a) => a.businessId === businessId);
  }

  async resolveApproval(
    approvalId: string,
    decision: "approved" | "declined",
    decidedBy: string,
    alternateValue?: unknown
  ) {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error(`Approval ${approvalId} not found`);
    approval.status = decision;
    approval.resolution = {
      decision,
      alternateValue,
      decidedAt: new Date().toISOString(),
      decidedBy,
    };
    this.approvals.set(approvalId, approval);
    return approval;
  }

  async createFollowUp(record: Omit<FollowUpRecord, "id" | "createdAt" | "status">) {
    const followUp: FollowUpRecord = {
      ...record,
      id: id("follow"),
      status: "scheduled",
      createdAt: new Date().toISOString(),
    };
    this.followUps.push(followUp);
    return followUp;
  }

  async listFollowUps(businessId: string) {
    return this.followUps.filter((f) => f.businessId === businessId);
  }
}

let singleton: MemoryBackend | undefined;

export function getBackend(): MemoryBackend {
  if (!singleton) singleton = new MemoryBackend();
  return singleton;
}
