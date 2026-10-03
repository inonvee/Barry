import { getSupabaseClient, isSupabaseConfigured } from "@/lib/store/supabase-client";
import { guardMissing } from "@/lib/state/lock";

/**
 * THE INBOUND INBOX — every customer message a channel delivers, recorded ONCE (unique per business,
 * channel and provider message id) before anything runs, in arrival order, with the exact stage it
 * reached. It is what makes provider retries and partial failures safe:
 *
 *   received ─► processing ─► reply_ready ─► sending ─► sent | dry_run | send_failed
 *        ▲            │
 *        └─ failed ◄──┘ (retryable, bounded)           failed_final · delivery_unknown · skipped
 *
 *  - a retry of a message whose turn already ran never runs it again (the turn is found by its inbound id);
 *  - a reply is sent at most once: "sending" is written BEFORE the provider call, so a crash between
 *    the call and its result leaves "sending" — which is never re-sent (delivery_unknown, said so);
 *  - messages of one conversation are processed in arrival order (seq).
 */

export type InboxStatus = "received" | "processing" | "failed" | "reply_ready" | "sending" | "sent" | "dry_run" | "send_failed" | "failed_final" | "delivery_unknown" | "skipped";

/** Statuses that need no more work. */
export const INBOX_DONE: InboxStatus[] = ["sent", "dry_run", "send_failed", "failed_final", "delivery_unknown", "skipped"];
export const MAX_INBOUND_ATTEMPTS = 3;

export type InboxRow = {
  id: string;
  seq: number;
  businessId: string;
  conversationId: string;
  channel: string;
  providerMessageId: string;
  customerId: string;
  body: string;
  meta: Record<string, unknown>;
  status: InboxStatus;
  attempts: number;
  reply?: string;
  /** The transcript `at` of BARRY's reply (to tie the delivery to its message). */
  replyAt?: string;
  providerReplyId?: string;
  error?: string;
  receivedAt: string;
  updatedAt: string;
};

export class InboxStageConflictError extends Error {
  constructor(readonly rowId: string, readonly expected: InboxStatus, readonly actual: InboxStatus | undefined) {
    super(`Inbox row ${rowId} is at "${actual}", not "${expected}" — another request moved it; nothing changed`);
    this.name = "InboxStageConflictError";
  }
}

export type NewInbound = Omit<InboxRow, "id" | "seq" | "status" | "attempts" | "updatedAt">;

export function inboxId(businessId: string, channel: string, providerMessageId: string): string {
  return `${businessId}:${channel}:${providerMessageId}`;
}

export interface InboxStore {
  /** Insert once; a second delivery of the same message returns the existing row with created=false. */
  claim(input: NewInbound): Promise<{ row: InboxRow; created: boolean }>;
  get(id: string): Promise<InboxRow | undefined>;
  /** The oldest row of this conversation that still needs work (received / failed under the limit / processing / reply_ready / sending). */
  nextOpen(conversationId: string): Promise<InboxRow | undefined>;
  /**
   * Change a row. With `from`, only if it is still at that stage (compare-and-swap): a request that lost its
   * lease can never move a row backwards (e.g. "sent" → "failed") — it gets InboxStageConflictError.
   */
  update(id: string, patch: Partial<Omit<InboxRow, "id" | "seq">>, from?: InboxStatus): Promise<InboxRow>;
  listByConversation(conversationId: string): Promise<InboxRow[]>;
}

/** Still needs work: not done, and a failure is retried only under the attempt limit. */
export const needsWork = (r: InboxRow) => r.status === "received" || r.status === "processing" || r.status === "reply_ready" || r.status === "sending" || (r.status === "failed" && r.attempts < MAX_INBOUND_ATTEMPTS);

export class MemoryInboxStore implements InboxStore {
  private rows = new Map<string, InboxRow>();
  private seq = 0;
  /** Tests: fail the next update to this status (simulates a persistence failure at that stage). */
  failNextUpdateTo: InboxStatus | undefined;

  async claim(input: NewInbound) {
    const id = inboxId(input.businessId, input.channel, input.providerMessageId);
    const existing = this.rows.get(id);
    if (existing) return { row: structuredClone(existing), created: false };
    const row: InboxRow = { ...input, id, seq: ++this.seq, status: "received", attempts: 0, updatedAt: new Date().toISOString() };
    this.rows.set(id, row);
    return { row: structuredClone(row), created: true };
  }

  async get(id: string) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : undefined;
  }

  async nextOpen(conversationId: string) {
    const r = [...this.rows.values()].filter((x) => x.conversationId === conversationId && needsWork(x)).sort((a, b) => a.seq - b.seq)[0];
    return r ? structuredClone(r) : undefined;
  }

  async update(id: string, patch: Partial<Omit<InboxRow, "id" | "seq">>, from?: InboxStatus) {
    const r = this.rows.get(id);
    if (!r) throw new Error(`Inbox row ${id} not found`);
    if (from && r.status !== from) throw new InboxStageConflictError(id, from, r.status);
    if (this.failNextUpdateTo && patch.status === this.failNextUpdateTo) {
      this.failNextUpdateTo = undefined;
      throw new Error(`inbox write failed (simulated) at ${patch.status}`);
    }
    Object.assign(r, patch, { updatedAt: new Date().toISOString() });
    return structuredClone(r);
  }

  async listByConversation(conversationId: string) {
    return [...this.rows.values()].filter((x) => x.conversationId === conversationId).sort((a, b) => a.seq - b.seq).map((x) => structuredClone(x));
  }

  reset(): void {
    this.rows.clear();
  }
}

function fromRow(r: Record<string, unknown>): InboxRow {
  return {
    id: r.id as string,
    seq: Number(r.seq),
    businessId: r.business_id as string,
    conversationId: r.conversation_id as string,
    channel: r.channel as string,
    providerMessageId: r.provider_message_id as string,
    customerId: r.customer_id as string,
    body: r.body as string,
    meta: (r.meta as Record<string, unknown>) ?? {},
    status: r.status as InboxStatus,
    attempts: Number(r.attempts ?? 0),
    ...(r.reply ? { reply: r.reply as string } : {}),
    ...(r.reply_at ? { replyAt: r.reply_at as string } : {}),
    ...(r.provider_reply_id ? { providerReplyId: r.provider_reply_id as string } : {}),
    ...(r.error ? { error: r.error as string } : {}),
    receivedAt: r.received_at as string,
    updatedAt: r.updated_at as string,
  };
}

const COLS: Record<string, string> = { status: "status", attempts: "attempts", reply: "reply", replyAt: "reply_at", providerReplyId: "provider_reply_id", error: "error", meta: "meta" };

export class SupabaseInboxStore implements InboxStore {
  private check(error: { code?: string; message?: string } | null, what: string): void {
    if (!error) return;
    if (error.code === "42P01" || error.code === "PGRST205" || /relation .*conversation_inbox.* does not exist|Could not find the table/i.test(error.message ?? "")) {
      guardMissing("inbound inbox unavailable");
    }
    throw new Error(`Inbox ${what} failed: ${error.message}`);
  }

  async claim(input: NewInbound) {
    const id = inboxId(input.businessId, input.channel, input.providerMessageId);
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("conversation_inbox")
      .upsert({ id, business_id: input.businessId, conversation_id: input.conversationId, channel: input.channel, provider_message_id: input.providerMessageId, customer_id: input.customerId, body: input.body, meta: input.meta, status: "received", attempts: 0, received_at: input.receivedAt }, { onConflict: "id", ignoreDuplicates: true })
      .select("*");
    this.check(error, "claim");
    if (data && data.length) return { row: fromRow(data[0]), created: true };
    const existing = await this.get(id);
    if (!existing) throw new Error(`Inbox row ${id} vanished`);
    return { row: existing, created: false };
  }

  async get(id: string) {
    const { data, error } = await getSupabaseClient().from("conversation_inbox").select("*").eq("id", id).maybeSingle();
    this.check(error, "read");
    return data ? fromRow(data) : undefined;
  }

  async nextOpen(conversationId: string) {
    const { data, error } = await getSupabaseClient().from("conversation_inbox").select("*").eq("conversation_id", conversationId).in("status", ["received", "processing", "reply_ready", "sending", "failed"]).order("seq", { ascending: true }).limit(20);
    this.check(error, "read");
    return (data ?? []).map(fromRow).find(needsWork);
  }

  async update(id: string, patch: Partial<Omit<InboxRow, "id" | "seq">>, from?: InboxStatus) {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(patch)) if (COLS[k]) row[COLS[k]] = v ?? null;
    let q = getSupabaseClient().from("conversation_inbox").update(row).eq("id", id);
    if (from) q = q.eq("status", from);
    const { data, error } = await q.select("*");
    this.check(error, "update");
    if (!data || data.length === 0) {
      const now = await this.get(id);
      throw new InboxStageConflictError(id, from ?? "received", now?.status);
    }
    return fromRow(data[0]);
  }

  async listByConversation(conversationId: string) {
    const { data, error } = await getSupabaseClient().from("conversation_inbox").select("*").eq("conversation_id", conversationId).order("seq", { ascending: true });
    this.check(error, "read");
    return (data ?? []).map(fromRow);
  }
}

const g = globalThis as { __barryInbox?: InboxStore };
export function getInboxStore(): InboxStore {
  if (!g.__barryInbox) g.__barryInbox = isSupabaseConfigured() ? new SupabaseInboxStore() : new MemoryInboxStore();
  return g.__barryInbox;
}
export function setInboxStoreForTests(store: InboxStore | undefined): void {
  g.__barryInbox = store;
}
