import { getSupabaseClient } from "./supabase-client";
import { isSimulatedPaymentProvider, SimulatedPaymentRefusedError } from "@/lib/payments/simulated";
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
  PaymentRequestRecord,
  PaymentWebhookEventRecord,
  OperatorRecord,
  OperatorRecordKind,
  QaPurgeResult,
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
    provider: row.provider as BookingRecord["provider"],
    providerEventId: row.provider_event_id as string | undefined,
    idempotencyKey: row.idempotency_key as string | undefined,
    verifiedAt: row.verified_at as string | undefined,
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
    provider: row.provider as PaymentRequestRecord["provider"],
    providerPaymentId: row.provider_payment_id as string | undefined,
    providerCheckoutUrl: row.provider_checkout_url as string | undefined,
    idempotencyKey: row.idempotency_key as string | undefined,
    verifiedAt: row.verified_at as string | undefined,
    providerEventId: row.provider_event_id as string | undefined,
    providerTransactionId: (row.provider_transaction_id as string | null) ?? undefined,
    binding: (row.binding as PaymentRequestRecord["binding"] | null) ?? undefined,
  };
}

function webhookEventFromRow(row: Record<string, unknown>): PaymentWebhookEventRecord {
  return {
    provider: row.provider as string,
    providerEventId: row.provider_event_id as string,
    paymentRequestId: row.payment_request_id as string,
    status: row.processing_status as PaymentWebhookEventRecord["status"],
    attempts: row.attempts as number,
    receivedAt: row.received_at as string,
    processedAt: row.processed_at as string | undefined,
    lastError: row.last_error as string | undefined,
  };
}

function connectionFromRow(row: Record<string, unknown>): ConnectionRecord {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    capability: row.capability as ConnectionRecord["capability"],
    provider: row.provider as string,
    status: row.status as ConnectionRecord["status"],
    config: (row.config as Record<string, unknown>) ?? {},
    credentialsRef: row.credentials_ref as string,
    permissions: (row.permissions as string[]) ?? [],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastVerifiedAt: row.last_verified_at as string | undefined,
  };
}

function learningRunFromRow(row: Record<string, unknown>): LearningRunRecord {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    status: row.status as LearningRunRecord["status"],
    approvedSources: (row.approved_sources as LearningRunRecord["approvedSources"]) ?? [],
    summary: (row.summary as Record<string, unknown>) ?? {},
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function learnedFactFromRow(row: Record<string, unknown>): LearnedFactRecord {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    runId: (row.run_id as string | null) ?? undefined,
    key: row.fact_key as string,
    value: typeof row.fact_value === "string" ? row.fact_value : JSON.stringify(row.fact_value),
    classification: row.classification as LearnedFactRecord["classification"],
    source: row.source as LearnedFactRecord["source"],
    confidence: row.confidence as LearnedFactRecord["confidence"],
    status: row.status as LearnedFactRecord["status"],
    ownerVerified: Boolean(row.owner_verified),
    correctedFrom: (row.corrected_from as string | null) ?? undefined,
    reviewedBy: (row.reviewed_by as string | null) ?? undefined,
    reviewedAt: (row.reviewed_at as string | null) ?? undefined,
    discoveredAt: row.discovered_at as string,
    refreshedAt: row.refreshed_at as string,
  };
}

function strategyFromRow(row: Record<string, unknown>): OperatingStrategyRecord {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    strategy: (row.strategy as Record<string, unknown>) ?? {},
    readiness: (row.readiness as Record<string, unknown>) ?? {},
    generatedAt: row.generated_at as string,
  };
}

function commerceCartFromRow(row: Record<string, unknown>): CommerceCartRecord {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    conversationId: row.conversation_id as string,
    customerId: row.customer_id as string,
    cartId: row.cart_id as string,
    status: row.status as CommerceCartRecord["status"],
    data: row.data,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function commerceOrderFromRow(row: Record<string, unknown>): CommerceOrderRecord {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    conversationId: row.conversation_id as string,
    customerId: row.customer_id as string,
    orderId: row.order_id as string,
    cartId: row.cart_id as string,
    totalAmount: Number(row.total_amount),
    currency: row.currency as string,
    status: row.status as CommerceOrderRecord["status"],
    idempotencyKey: row.idempotency_key as string,
    verifiedAt: row.verified_at as string,
    data: row.data,
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
      provider: record.provider,
      provider_event_id: record.providerEventId,
      idempotency_key: record.idempotencyKey,
      verified_at: record.verifiedAt,
    };
    const { data, error } = await client.from("bookings").insert(row).select("*").single();
    if (error) {
      // 23505 = unique_violation. bookings_resource_slot_confirmed_uidx
      // (migration 0002) means a second concurrent createBooking for the
      // same resource+time can never silently double-book — it lands
      // here instead, as the same "slot no longer available" outcome the
      // app-level check-then-insert in tools/definitions.ts already
      // produces for the non-racing case.
      if (error.code === "23505" && error.message.includes("bookings_idempotency_key_confirmed_uidx")) {
        throw new Error("Booking already exists for this request");
      }
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
      provider: record.provider,
      provider_payment_id: record.providerPaymentId,
      provider_checkout_url: record.providerCheckoutUrl,
      idempotency_key: record.idempotencyKey,
      // Only written when present (migration 0010), so payment flows without
      // a cart binding keep working on a database that predates it.
      ...(record.binding ? { binding: record.binding } : {}),
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

  async listPaymentRequests(businessId: string): Promise<PaymentRequestRecord[]> {
    const client = getSupabaseClient();
    const { data, error } = await client.from("payment_requests").select("*").eq("business_id", businessId);
    if (error) throw new Error(`Failed to list payment requests: ${error.message}`);
    return (data ?? []).map(paymentFromRow);
  }

  async getPaymentRequest(paymentId: string): Promise<PaymentRequestRecord | undefined> {
    const client = getSupabaseClient();
    const { data, error } = await client.from("payment_requests").select("*").eq("id", paymentId).maybeSingle();
    if (error) throw new Error(`Failed to load payment request ${paymentId}: ${error.message}`);
    return data ? paymentFromRow(data) : undefined;
  }

  async findPaymentRequestByIdempotencyKey(
    businessId: string,
    idempotencyKey: string
  ): Promise<PaymentRequestRecord | undefined> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("payment_requests")
      .select("*")
      .eq("business_id", businessId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw new Error(`Failed to load payment request by idempotency key: ${error.message}`);
    return data ? paymentFromRow(data) : undefined;
  }

  async findPaymentRequestByProviderPaymentId(
    provider: string,
    providerPaymentId: string
  ): Promise<PaymentRequestRecord | undefined> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("payment_requests")
      .select("*")
      .eq("provider", provider)
      .eq("provider_payment_id", providerPaymentId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load payment request by provider id: ${error.message}`);
    return data ? paymentFromRow(data) : undefined;
  }

  async updatePaymentRequestStatus(
    paymentId: string,
    status: PaymentRequestRecord["status"],
    metadata: { verifiedAt?: string; providerEventId?: string; providerTransactionId?: string } = {}
  ): Promise<PaymentRequestRecord> {
    const existing = await this.getPaymentRequest(paymentId);
    if (!existing) throw new Error(`Payment request ${paymentId} not found`);
    if (existing.status === "paid" && status !== "paid") return existing;
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("payment_requests")
      .update({
        status,
        verified_at: metadata.verifiedAt ?? existing.verifiedAt ?? null,
        provider_event_id: metadata.providerEventId ?? existing.providerEventId ?? null,
        ...(metadata.providerTransactionId ? { provider_transaction_id: metadata.providerTransactionId } : {}),
      })
      .eq("id", paymentId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to update payment request ${paymentId}: ${error.message}`);
    return paymentFromRow(data);
  }

  async recordPaymentWebhookEvent(
    provider: string,
    providerEventId: string,
    paymentRequestId: string
  ): Promise<PaymentWebhookEventRecord> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("payment_webhook_events")
      .insert({
        provider,
        provider_event_id: providerEventId,
        payment_request_id: paymentRequestId,
        processing_status: "processing",
      })
      .select("*")
      .single();
    if (!error && data) return webhookEventFromRow(data);
    if (error && error.code !== "23505") {
      throw new Error(`Failed to record payment webhook event: ${error.message}`);
    }

    const { data: existing, error: loadError } = await client
      .from("payment_webhook_events")
      .select("*")
      .eq("provider", provider)
      .eq("provider_event_id", providerEventId)
      .single();
    if (loadError) throw new Error(`Failed to load payment webhook event: ${loadError.message}`);
    if (existing.payment_request_id !== paymentRequestId) throw new Error("Payment webhook event/payment mismatch");
    if (existing.processing_status === "completed") return webhookEventFromRow(existing);

    const { data: updated, error: updateError } = await client
      .from("payment_webhook_events")
      .update({
        processing_status: "processing",
        attempts: (existing.attempts as number) + 1,
      })
      .eq("provider", provider)
      .eq("provider_event_id", providerEventId)
      .select("*")
      .single();
    if (updateError) throw new Error(`Failed to update payment webhook event: ${updateError.message}`);
    return webhookEventFromRow(updated);
  }

  async markPaymentWebhookEventCompleted(
    provider: string,
    providerEventId: string,
    paymentRequestId: string
  ): Promise<PaymentWebhookEventRecord> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("payment_webhook_events")
      .update({
        processing_status: "completed",
        processed_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("provider", provider)
      .eq("provider_event_id", providerEventId)
      .eq("payment_request_id", paymentRequestId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to complete payment webhook event: ${error.message}`);
    return webhookEventFromRow(data);
  }

  async markPaymentWebhookEventFailed(
    provider: string,
    providerEventId: string,
    paymentRequestId: string,
    errorMessage: string
  ): Promise<PaymentWebhookEventRecord> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("payment_webhook_events")
      .update({
        processing_status: "failed",
        last_error: errorMessage.slice(0, 500),
      })
      .eq("provider", provider)
      .eq("provider_event_id", providerEventId)
      .eq("payment_request_id", paymentRequestId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to fail payment webhook event: ${error.message}`);
    return webhookEventFromRow(data);
  }

  async simulatePaymentOutcome(
    paymentId: string,
    outcome: "paid" | "failed"
  ): Promise<PaymentRequestRecord> {
    const existing = await this.getPaymentRequest(paymentId);
    if (!existing) throw new Error(`Payment request ${paymentId} not found`);
    // Test money only: a real provider's payment is settled by that provider's verification, never here.
    if (!isSimulatedPaymentProvider(existing.provider)) throw new SimulatedPaymentRefusedError(existing.provider!);
    return this.updatePaymentRequestStatus(paymentId, outcome, { verifiedAt: new Date().toISOString() });
  }

  async getBusinessConnection(
    businessId: string,
    capability: ConnectionCapability
  ): Promise<ConnectionRecord | undefined> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("business_connections")
      .select("*")
      .eq("business_id", businessId)
      .eq("capability", capability)
      .maybeSingle();
    if (error) throw new Error(`Failed to load business connection: ${error.message}`);
    return data ? connectionFromRow(data) : undefined;
  }

  async upsertBusinessConnection(
    record: Omit<ConnectionRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<ConnectionRecord> {
    const client = getSupabaseClient();
    const existing = await this.getBusinessConnection(record.businessId, record.capability);
    const row = {
      id: existing?.id ?? id("conn"),
      business_id: record.businessId,
      capability: record.capability,
      provider: record.provider,
      status: record.status,
      config: record.config,
      credentials_ref: record.credentialsRef,
      permissions: record.permissions,
      last_verified_at: record.lastVerifiedAt ?? null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await client
      .from("business_connections")
      .upsert(row, { onConflict: "business_id,capability" })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to upsert business connection: ${error.message}`);
    return connectionFromRow(data);
  }

  async listBusinessConnections(businessId: string): Promise<ConnectionRecord[]> {
    const client = getSupabaseClient();
    const { data, error } = await client.from("business_connections").select("*").eq("business_id", businessId);
    if (error) throw new Error(`Failed to list business connections: ${error.message}`);
    return (data ?? []).map(connectionFromRow);
  }

  async createLearningRun(record: Omit<LearningRunRecord, "id" | "createdAt" | "updatedAt">): Promise<LearningRunRecord> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("business_learning_runs")
      .insert({
        id: id("lrun"),
        business_id: record.businessId,
        status: record.status,
        approved_sources: record.approvedSources,
        summary: record.summary,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to create learning run: ${error.message}`);
    return learningRunFromRow(data);
  }

  async updateLearningRun(runId: string, patch: Partial<Pick<LearningRunRecord, "status" | "summary">>): Promise<LearningRunRecord> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("business_learning_runs")
      .update({ ...(patch.status ? { status: patch.status } : {}), ...(patch.summary ? { summary: patch.summary } : {}), updated_at: new Date().toISOString() })
      .eq("id", runId)
      .select("*")
      .single();
    if (error) throw new Error(`Failed to update learning run: ${error.message}`);
    return learningRunFromRow(data);
  }

  async getLatestLearningRun(businessId: string): Promise<LearningRunRecord | undefined> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("business_learning_runs")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to load learning run: ${error.message}`);
    return data ? learningRunFromRow(data) : undefined;
  }

  async listLearnedFacts(businessId: string): Promise<LearnedFactRecord[]> {
    const client = getSupabaseClient();
    const { data, error } = await client.from("learned_business_facts").select("*").eq("business_id", businessId);
    if (error) throw new Error(`Failed to list learned facts: ${error.message}`);
    return (data ?? []).map(learnedFactFromRow);
  }

  async upsertLearnedFact(record: Omit<LearnedFactRecord, "id">): Promise<LearnedFactRecord> {
    const client = getSupabaseClient();
    const { data: existing, error: loadError } = await client
      .from("learned_business_facts")
      .select("id")
      .eq("business_id", record.businessId)
      .eq("fact_key", record.key)
      .maybeSingle();
    if (loadError) throw new Error(`Failed to load learned fact: ${loadError.message}`);
    const { data, error } = await client
      .from("learned_business_facts")
      .upsert(
        {
          id: (existing?.id as string | undefined) ?? id("lfact"),
          business_id: record.businessId,
          run_id: record.runId ?? null,
          fact_key: record.key,
          fact_value: record.value,
          classification: record.classification,
          source: record.source,
          confidence: record.confidence,
          status: record.status,
          owner_verified: record.ownerVerified,
          corrected_from: record.correctedFrom ?? null,
          reviewed_by: record.reviewedBy ?? null,
          reviewed_at: record.reviewedAt ?? null,
          discovered_at: record.discoveredAt,
          refreshed_at: record.refreshedAt,
        },
        { onConflict: "business_id,fact_key" }
      )
      .select("*")
      .single();
    if (error) throw new Error(`Failed to upsert learned fact: ${error.message}`);
    return learnedFactFromRow(data);
  }

  async saveOperatingStrategy(record: Omit<OperatingStrategyRecord, "id" | "generatedAt">): Promise<OperatingStrategyRecord> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("business_operating_strategies")
      .insert({ id: id("lstrat"), business_id: record.businessId, strategy: record.strategy, readiness: record.readiness })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to save operating strategy: ${error.message}`);
    return strategyFromRow(data);
  }

  async getLatestOperatingStrategy(businessId: string): Promise<OperatingStrategyRecord | undefined> {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("business_operating_strategies")
      .select("*")
      .eq("business_id", businessId)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to load operating strategy: ${error.message}`);
    return data ? strategyFromRow(data) : undefined;
  }

  async listCommerceCarts(businessId: string): Promise<CommerceCartRecord[]> {
    const client = getSupabaseClient();
    const { data, error } = await client.from("commerce_carts").select("*").eq("business_id", businessId);
    if (error) throw new Error(`Failed to list commerce carts: ${error.message}`);
    return (data ?? []).map(commerceCartFromRow);
  }

  async upsertCommerceCart(
    record: Omit<CommerceCartRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<CommerceCartRecord> {
    const client = getSupabaseClient();
    const row = {
      id: id("ccart"),
      business_id: record.businessId,
      conversation_id: record.conversationId,
      customer_id: record.customerId,
      cart_id: record.cartId,
      status: record.status,
      data: record.data,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await client
      .from("commerce_carts")
      .upsert(row, { onConflict: "business_id,cart_id" })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to upsert commerce cart: ${error.message}`);
    return commerceCartFromRow(data);
  }

  async listCommerceOrders(businessId: string): Promise<CommerceOrderRecord[]> {
    const client = getSupabaseClient();
    const { data, error } = await client.from("commerce_orders").select("*").eq("business_id", businessId);
    if (error) throw new Error(`Failed to list commerce orders: ${error.message}`);
    return (data ?? []).map(commerceOrderFromRow);
  }

  async createCommerceOrder(
    record: Omit<CommerceOrderRecord, "id" | "createdAt">
  ): Promise<CommerceOrderRecord> {
    const client = getSupabaseClient();
    const row = {
      id: id("corder"),
      business_id: record.businessId,
      conversation_id: record.conversationId,
      customer_id: record.customerId,
      order_id: record.orderId,
      cart_id: record.cartId,
      total_amount: record.totalAmount,
      currency: record.currency,
      status: record.status,
      idempotency_key: record.idempotencyKey,
      verified_at: record.verifiedAt,
      data: record.data,
    };
    const { data, error } = await client.from("commerce_orders").insert(row).select("*").single();
    if (error) {
      if (error.code === "23505") {
        const existing = (await this.listCommerceOrders(record.businessId)).find((order) => order.idempotencyKey === record.idempotencyKey);
        if (existing) return existing;
      }
      throw new Error(`Failed to create commerce order: ${error.message}`);
    }
    return commerceOrderFromRow(data);
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
      // Compare-and-set: only a PENDING approval can be resolved, so two concurrent resolutions (a
      // double click, a stale tab, an owner racing a customer withdrawal) can never both win.
      .eq("status", "pending")
      .select("*")
      .maybeSingle();
    if (error) throw new Error(`Failed to resolve approval ${approvalId}: ${error.message}`);
    if (!data) throw new ApprovalAlreadyResolvedError(approvalId);
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

  // ── Operator records (migration 0012) ──────────────────────────────────

  async listOperatorRecords(businessId: string, kind: OperatorRecordKind): Promise<OperatorRecord[]> {
    const client = getSupabaseClient();
    const { data, error } = await client.from("operator_records").select("*").eq("business_id", businessId).eq("kind", kind);
    if (error) throw new Error(`Failed to list operator records: ${error.message}`);
    return (data ?? []).map(operatorRecordFromRow);
  }

  async upsertOperatorRecord(record: Omit<OperatorRecord, "id" | "createdAt" | "updatedAt">): Promise<OperatorRecord> {
    const client = getSupabaseClient();
    const row = { id: id("oprec"), business_id: record.businessId, kind: record.kind, key: record.key, data: record.data, updated_at: new Date().toISOString() };
    const { data, error } = await client.from("operator_records").upsert(row, { onConflict: "business_id,kind,key" }).select("*").single();
    if (error) throw new Error(`Failed to upsert operator record: ${error.message}`);
    return operatorRecordFromRow(data);
  }

  async deleteOperatorRecords(businessId: string, kind: OperatorRecordKind, keys?: string[]): Promise<number> {
    const client = getSupabaseClient();
    let q = client.from("operator_records").delete({ count: "exact" }).eq("business_id", businessId).eq("kind", kind);
    if (keys) q = q.in("key", keys);
    const { count, error } = await q;
    if (error) throw new Error(`Failed to delete operator records: ${error.message}`);
    return count ?? 0;
  }

  async listOperatorRecordsAcrossBusinesses(kind: OperatorRecordKind): Promise<OperatorRecord[]> {
    const client = getSupabaseClient();
    const { data, error } = await client.from("operator_records").select("*").eq("kind", kind);
    if (error) throw new Error(`Failed to list operator records across businesses: ${error.message}`);
    return (data ?? []).map(operatorRecordFromRow);
  }

  async purgeQaRecords(businessId: string, conversationPrefix: string): Promise<QaPurgeResult> {
    if (!conversationPrefix) throw new Error("A conversation prefix is required to purge QA records");
    const client = getSupabaseClient();
    const out: QaPurgeResult = {};
    // A LIKE pattern on the prefix only: no wildcard characters from the caller ever reach the query.
    const pattern = `${conversationPrefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    for (const table of ["payment_requests", "approvals", "bookings", "commerce_carts", "commerce_orders", "follow_ups"]) {
      const { count, error } = await client.from(table).delete({ count: "exact" }).eq("business_id", businessId).like("conversation_id", pattern);
      if (error) throw new Error(`Failed to purge ${table}: ${error.message}`);
      out[table] = count ?? 0;
    }
    return out;
  }
}

function operatorRecordFromRow(row: Record<string, unknown>): OperatorRecord {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    kind: row.kind as OperatorRecordKind,
    key: row.key as string,
    data: (row.data as Record<string, unknown>) ?? {},
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
