import { ApprovalAlreadyResolvedError } from "./types";
import type {
  ApprovalRecord,
  BarryBackend,
  BookingRecord,
  ConnectionCapability,
  ConnectionRecord,
  CommerceCartRecord,
  CommerceOrderRecord,
  FollowUpRecord,
  LearnedFactRecord,
  LearningRunRecord,
  OperatingStrategyRecord,
  OperatorRecord,
  OperatorRecordKind,
  PaymentWebhookEventRecord,
  PaymentRequestRecord,
  QaPurgeResult,
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
  private learningRuns = new Map<string, LearningRunRecord>();
  private learnedFacts = new Map<string, LearnedFactRecord>(); // `${businessId}:${key}`
  private strategies: OperatingStrategyRecord[] = [];
  private operatorRecords = new Map<string, OperatorRecord>(); // `${businessId}:${kind}:${key}`

  async listOperatorRecords(businessId: string, kind: OperatorRecordKind): Promise<OperatorRecord[]> {
    return [...this.operatorRecords.values()].filter((r) => r.businessId === businessId && r.kind === kind).map((r) => structuredClone(r));
  }

  async upsertOperatorRecord(record: Omit<OperatorRecord, "id" | "createdAt" | "updatedAt">): Promise<OperatorRecord> {
    const k = `${record.businessId}:${record.kind}:${record.key}`;
    const now = new Date().toISOString();
    const existing = this.operatorRecords.get(k);
    const row: OperatorRecord = existing ? { ...existing, data: structuredClone(record.data), updatedAt: now } : { ...record, data: structuredClone(record.data), id: id("oprec"), createdAt: now, updatedAt: now };
    this.operatorRecords.set(k, row);
    return structuredClone(row);
  }

  async deleteOperatorRecords(businessId: string, kind: OperatorRecordKind, keys?: string[]): Promise<number> {
    let n = 0;
    for (const [k, r] of this.operatorRecords) {
      if (r.businessId !== businessId || r.kind !== kind || (keys && !keys.includes(r.key))) continue;
      this.operatorRecords.delete(k);
      n++;
    }
    return n;
  }

  async listOperatorRecordsAcrossBusinesses(kind: OperatorRecordKind): Promise<OperatorRecord[]> {
    return [...this.operatorRecords.values()].filter((r) => r.kind === kind).map((r) => structuredClone(r));
  }

  async purgeQaRecords(businessId: string, conversationPrefix: string): Promise<QaPurgeResult> {
    const mine = <T extends { businessId: string; conversationId: string }>(r: T) => r.businessId === businessId && r.conversationId.startsWith(conversationPrefix);
    const out: QaPurgeResult = { payment_requests: 0, approvals: 0, bookings: 0, commerce_carts: 0, commerce_orders: 0, follow_ups: 0 };
    for (const [k, r] of this.paymentRequests) if (mine(r)) (this.paymentRequests.delete(k), out.payment_requests++);
    for (const [k, r] of this.approvals) if (mine(r)) (this.approvals.delete(k), out.approvals++);
    for (const [k, r] of this.commerceCarts) if (mine(r)) (this.commerceCarts.delete(k), out.commerce_carts++);
    for (const [k, r] of this.commerceOrders) if (mine(r)) (this.commerceOrders.delete(k), out.commerce_orders++);
    const bookingsBefore = this.bookings.length;
    this.bookings = this.bookings.filter((b) => !mine(b));
    out.bookings = bookingsBefore - this.bookings.length;
    const followBefore = this.followUps.length;
    this.followUps = this.followUps.filter((f) => !mine(f));
    out.follow_ups = followBefore - this.followUps.length;
    return out;
  }

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
    metadata: { verifiedAt?: string; providerEventId?: string; providerTransactionId?: string } = {}
  ) {
    const pr = this.paymentRequests.get(paymentId);
    if (!pr) throw new Error(`Payment request ${paymentId} not found`);
    if (pr.status === "paid" && status !== "paid") return pr;
    pr.status = status;
    pr.verifiedAt = metadata.verifiedAt ?? pr.verifiedAt;
    pr.providerEventId = metadata.providerEventId ?? pr.providerEventId;
    pr.providerTransactionId = metadata.providerTransactionId ?? pr.providerTransactionId;
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

  async listBusinessConnections(businessId: string) {
    return [...this.businessConnections.values()].filter((c) => c.businessId === businessId).map((c) => structuredClone(c));
  }

  async createLearningRun(record: Omit<LearningRunRecord, "id" | "createdAt" | "updatedAt">) {
    const now = new Date().toISOString();
    const run: LearningRunRecord = { ...structuredClone(record), id: id("lrun"), createdAt: now, updatedAt: now };
    this.learningRuns.set(run.id, run);
    return structuredClone(run);
  }

  async updateLearningRun(runId: string, patch: Partial<Pick<LearningRunRecord, "status" | "summary">>) {
    const run = this.learningRuns.get(runId);
    if (!run) throw new Error(`Learning run ${runId} not found`);
    const updated: LearningRunRecord = { ...run, ...structuredClone(patch), updatedAt: new Date().toISOString() };
    this.learningRuns.set(runId, updated);
    return structuredClone(updated);
  }

  async getLatestLearningRun(businessId: string) {
    const runs = [...this.learningRuns.values()].filter((r) => r.businessId === businessId);
    const latest = runs.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1))[0];
    return latest ? structuredClone(latest) : undefined;
  }

  async listLearnedFacts(businessId: string) {
    return [...this.learnedFacts.values()].filter((f) => f.businessId === businessId).map((f) => structuredClone(f));
  }

  async upsertLearnedFact(record: Omit<LearnedFactRecord, "id">) {
    const key = `${record.businessId}:${record.key}`;
    const existing = this.learnedFacts.get(key);
    const fact: LearnedFactRecord = { ...structuredClone(record), id: existing?.id ?? id("lfact") };
    this.learnedFacts.set(key, fact);
    return structuredClone(fact);
  }

  async saveOperatingStrategy(record: Omit<OperatingStrategyRecord, "id" | "generatedAt">) {
    const saved: OperatingStrategyRecord = { ...structuredClone(record), id: id("lstrat"), generatedAt: new Date().toISOString() };
    this.strategies.push(saved);
    return structuredClone(saved);
  }

  async getLatestOperatingStrategy(businessId: string) {
    const latest = this.strategies.filter((s) => s.businessId === businessId).at(-1);
    return latest ? structuredClone(latest) : undefined;
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
    // Compare-and-set, as in the database: only a pending approval can be resolved.
    if (approval.status !== "pending") throw new ApprovalAlreadyResolvedError(approvalId);
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

// Kept on globalThis: in `next dev`, route handlers and pages are separate
// module graphs, and must still see the same process-local data.
const holder = globalThis as { __barryMemoryBackend?: MemoryBackend };

export function getBackend(): MemoryBackend {
  if (!holder.__barryMemoryBackend) holder.__barryMemoryBackend = new MemoryBackend();
  return holder.__barryMemoryBackend;
}
