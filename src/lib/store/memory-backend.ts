import type {
  ApprovalRecord,
  BarryBackend,
  BookingRecord,
  FollowUpRecord,
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

  async simulatePaymentOutcome(paymentId: string, outcome: "paid" | "failed") {
    const pr = this.paymentRequests.get(paymentId);
    if (!pr) throw new Error(`Payment request ${paymentId} not found`);
    pr.status = outcome;
    this.paymentRequests.set(paymentId, pr);
    return pr;
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
