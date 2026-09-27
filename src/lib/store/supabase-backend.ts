import { getSupabaseClient } from "./supabase-client";
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

function bookingFromRow(row: Record<string, unknown>): BookingRecord {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    offerId: row.offer_id as string,
    resourceId: row.resource_id as string,
    start: row.start_at as string,
    end: row.end_at as string,
    customerId: row.customer_id as string,
    conversationId: row.conversation_id as string,
    partySize: row.party_size as number,
    status: row.status as BookingRecord["status"],
    createdAt: row.created_at as string,
  };
}

function paymentFromRow(row: Record<string, unknown>): PaymentRequestRecord {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    conversationId: row.conversation_id as string,
    customerId: row.customer_id as string,
    amount: Number(row.amount),
    currency: row.currency as string,
    reason: row.reason as string,
    status: row.status as PaymentRequestRecord["status"],
    createdAt: row.created_at as string,
  };
}

function approvalFromRow(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    conversationId: row.conversation_id as string,
    customerId: row.customer_id as string,
    requestedAction: row.requested_action as string,
    requestedInput: row.requested_input,
    reason: row.reason as string,
    policyId: row.policy_id as string,
    proposedValue: row.proposed_value,
    status: row.status as ApprovalRecord["status"],
    resolution: (row.resolution as ApprovalRecord["resolution"]) ?? undefined,
    createdAt: row.created_at as string,
  };
}

function followUpFromRow(row: Record<string, unknown>): FollowUpRecord {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    conversationId: row.conversation_id as string,
    customerId: row.customer_id as string,
    reason: row.reason as string,
    dueAt: row.due_at as string,
    status: row.status as FollowUpRecord["status"],
    createdAt: row.created_at as string,
  };
}

/**
 * Supabase-backed implementation of BarryBackend. Same contract as
 * MemoryBackend — the runtime and tool adapters never know which one is
 * active (see `getBackend()` in `index.ts`).
 */
export class SupabaseBackend implements BarryBackend {
  async listBookings(businessId: string): Promise<BookingRecord[]> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("bookings")
      .select("*")
      .eq("business_id", businessId)
      .eq("status", "confirmed");
    if (error) throw new Error(`Failed to list bookings: ${error.message}`);
    return (data ?? []).map(bookingFromRow);
  }

  async createBooking(record: Omit<BookingRecord, "id" | "createdAt" | "status">): Promise<BookingRecord> {
    const client = getSupabaseClient();
    const row = {
      id: id("booking"),
      business_id: record.businessId,
      offer_id: record.offerId,
      resource_id: record.resourceId,
      start_at: record.start,
      end_at: record.end,
      customer_id: record.customerId,
      conversation_id: record.conversationId,
      party_size: record.partySize,
      status: "confirmed" as const,
    };
    const { data, error } = await client.from("bookings").insert(row).select("*").single();
    if (error) {
      // 23505 = unique_violation. bookings_resource_slot_confirmed_uidx
      // (migration 0002) means a second concurrent createBooking for the
      // same resource+time can never silently double-book — it lands
      // here instead, as the same "slot no longer available" outcome the
      // app-level check-then-insert in tools/definitions.ts already
      // produces for the non-racing case.
      if (error.code === "23505") throw new Error("Slot no longer available");
      throw new Error(`Failed to create booking: ${error.message}`);
    }
    return bookingFromRow(data);
  }

  async getInventory(businessId: string, sku: string, baseQuantity: number): Promise<number> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("inventory_adjustments")
      .select("consumed_quantity")
      .eq("business_id", businessId)
      .eq("sku", sku)
      .maybeSingle();
    if (error) throw new Error(`Failed to read inventory for ${sku}: ${error.message}`);
    const consumed = data?.consumed_quantity ?? 0;
    return Math.max(0, baseQuantity - consumed);
  }

  async decrementInventory(businessId: string, sku: string, quantity: number, baseQuantity: number): Promise<boolean> {
    const client = getSupabaseClient();
    // A single atomic UPDATE (migration 0004's reserve_inventory function)
    // guarded by baseQuantity — never a select-then-upsert from JS, which
    // both races under concurrent fulfillOrder calls for the same SKU AND
    // (migration 0002's now-superseded increment_inventory_consumed) had
    // no oversell guard at all, letting consumed exceed baseQuantity.
    const { data, error } = await client.rpc("reserve_inventory", {
      p_business_id: businessId,
      p_sku: sku,
      p_quantity: quantity,
      p_base_quantity: baseQuantity,
    });
    if (error) throw new Error(`Failed to decrement inventory for ${sku}: ${error.message}`);
    return data === true;
  }

  async createPaymentRequest(
    record: Omit<PaymentRequestRecord, "id" | "createdAt" | "status">
  ): Promise<PaymentRequestRecord> {
    const client = getSupabaseClient();
    const row = {
      id: id("pay"),
      business_id: record.businessId,
      conversation_id: record.conversationId,
      customer_id: record.customerId,
      amount: record.amount,
      currency: record.currency,
      reason: record.reason,
      status: "pending" as const,
    };
    const { data, error } = await client.from("payment_requests").insert(row).select("*").single();
    if (error) {
      // payment_requests_one_pending_per_conversation_uidx (migration 0002)
      // means a retried request can never create a second pending payment
      // request for the same conversation.
      if (error.code === "23505") throw new Error("A payment request is already pending for this conversation");
      throw new Error(`Failed to create payment request: ${error.message}`);
    }
    return paymentFromRow(data);
  }

  async getPaymentRequest(paymentId: string): Promise<PaymentRequestRecord | undefined> {
    const client = getSupabaseClient();
    const { data, error } = await client.from("payment_requests").select("*").eq("id", paymentId).maybeSingle();
    if (error) throw new Error(`Failed to load payment request ${paymentId}: ${error.message}`);
    return data ? paymentFromRow(data) : undefined;
  }

  async simulatePaymentOutcome(
    paymentId: string,
    outcome: "paid" | "failed"
  ): Promise<PaymentRequestRecord> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("payment_requests")
      .update({ status: outcome })
      .eq("id", paymentId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to update payment request ${paymentId}: ${error.message}`);
    return paymentFromRow(data);
  }

  async createApproval(record: Omit<ApprovalRecord, "id" | "createdAt" | "status">): Promise<ApprovalRecord> {
    const client = getSupabaseClient();
    const row = {
      id: id("appr"),
      business_id: record.businessId,
      conversation_id: record.conversationId,
      customer_id: record.customerId,
      requested_action: record.requestedAction,
      requested_input: record.requestedInput,
      reason: record.reason,
      policy_id: record.policyId,
      proposed_value: record.proposedValue,
      status: "pending" as const,
    };
    const { data, error } = await client.from("approvals").insert(row).select("*").single();
    if (error) throw new Error(`Failed to create approval: ${error.message}`);
    return approvalFromRow(data);
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    const client = getSupabaseClient();
    const { data, error } = await client.from("approvals").select("*").eq("id", approvalId).maybeSingle();
    if (error) throw new Error(`Failed to load approval ${approvalId}: ${error.message}`);
    return data ? approvalFromRow(data) : undefined;
  }

  async listApprovals(businessId: string): Promise<ApprovalRecord[]> {
    const client = getSupabaseClient();
    const { data, error } = await client.from("approvals").select("*").eq("business_id", businessId);
    if (error) throw new Error(`Failed to list approvals: ${error.message}`);
    return (data ?? []).map(approvalFromRow);
  }

  async resolveApproval(
    approvalId: string,
    decision: "approved" | "declined",
    decidedBy: string,
    alternateValue?: unknown
  ): Promise<ApprovalRecord> {
    const client = getSupabaseClient();
    const resolution = {
      decision,
      alternateValue,
      decidedAt: new Date().toISOString(),
      decidedBy,
    };
    const { data, error } = await client
      .from("approvals")
      .update({ status: decision, resolution })
      .eq("id", approvalId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to resolve approval ${approvalId}: ${error.message}`);
    return approvalFromRow(data);
  }

  async createFollowUp(record: Omit<FollowUpRecord, "id" | "createdAt" | "status">): Promise<FollowUpRecord> {
    const client = getSupabaseClient();
    const row = {
      id: id("follow"),
      business_id: record.businessId,
      conversation_id: record.conversationId,
      customer_id: record.customerId,
      reason: record.reason,
      due_at: record.dueAt,
      status: "scheduled" as const,
    };
    const { data, error } = await client.from("follow_ups").insert(row).select("*").single();
    if (error) throw new Error(`Failed to create follow-up: ${error.message}`);
    return followUpFromRow(data);
  }

  async listFollowUps(businessId: string): Promise<FollowUpRecord[]> {
    const client = getSupabaseClient();
    const { data, error } = await client.from("follow_ups").select("*").eq("business_id", businessId);
    if (error) throw new Error(`Failed to list follow-ups: ${error.message}`);
    return (data ?? []).map(followUpFromRow);
  }
}
