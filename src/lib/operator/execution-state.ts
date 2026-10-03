import type { ConversationState } from "@/lib/state";
import { readLedger, type LedgerEntry } from "@/lib/runtime/ledger";

/**
 * EXECUTION STATE — the one vocabulary for "how far did this action get", so no surface can say more
 * than the records prove:
 *
 *   planned            known work, not due yet (a rule's delay, a scheduled slot)
 *   queued             due now; BARRY will act on the next pass
 *   attempted          a send was started but no result was recorded (never "sent")
 *   dry_run            TEST MODE: the message was composed and recorded, nothing left BARRY
 *   sent               the channel accepted the message (a provider message id, or the live web reply)
 *   delivered          the provider later confirmed delivery (only where a confirmation is recorded)
 *   failed             the channel refused it; the customer got nothing
 *   verified_outcome   the result the work was for, proven by its own record (e.g. a provider-verified payment)
 *
 * Words the owner reads — "sent", "reached", "contacted" — require `sent` or better; "paid" / "completed"
 * require a verified outcome. A dry run is never contact, never a transcript message and never "sent".
 */
export type ExecutionState = "planned" | "queued" | "attempted" | "dry_run" | "sent" | "delivered" | "failed" | "verified_outcome";

/** Only these states mean the customer actually received something. */
export function reachedCustomer(state: ExecutionState | undefined): boolean {
  return state === "sent" || state === "delivered";
}

/** An executor attempt / owner-operation result / delivery status → execution state (skipped & cancelled are not executions). */
export function executionStateOf(status: string | undefined): ExecutionState | undefined {
  switch (status) {
    case "sent":
      return "sent";
    case "delivered":
    case "read":
      return "delivered";
    case "dry_run":
      return "dry_run";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

// ── Delivery records (per conversation) ─────────────────────────────────────────────────────────

/** Where a conversation keeps the delivery result of each outbound message (replies and follow-ups). */
export const CHANNEL_DELIVERY_KEY = "__channelDelivery";

export type DeliveryStatus = "sent" | "dry_run" | "failed";

/** The minimal shape every delivery record has (see channels/gateway DeliveryRecord). */
type DeliveryLike = { at: string; inboundId: string; status: DeliveryStatus; messageAt?: string };

function readDeliveryList(knownFields: Record<string, string>): DeliveryLike[] {
  try {
    const parsed = JSON.parse(knownFields[CHANNEL_DELIVERY_KEY] ?? "[]");
    return Array.isArray(parsed) ? (parsed as DeliveryLike[]) : [];
  } catch {
    return [];
  }
}

/** Executor attempts have ids `<obligation key>#<n>`; channel message ids never contain "#". */
const isAttemptId = (id: string) => /#\d+$/.test(id);

/** One instant, whatever its ISO spelling ("…Z" from the app, "…+00:00" back from Postgres). */
const instant = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : String(t);
};

/**
 * BARRY messages in the transcript that did NOT reach the customer, keyed by the message's instant (see `instant`):
 *  - new records name the message they belong to (`messageAt`);
 *  - LEGACY follow-up records (before this model) wrote the dry-run text into the transcript at exactly the
 *    attempt's time, so an attempt-id delivery's own `at` identifies its message.
 * Legacy channel replies without `messageAt` can't be matched to a message and are left as they were.
 */
export function undeliveredMessages(knownFields: Record<string, string>): Map<string, "dry_run" | "failed"> {
  const out = new Map<string, "dry_run" | "failed">();
  for (const d of readDeliveryList(knownFields)) {
    if (d.status === "sent") continue;
    const at = d.messageAt ?? (isAttemptId(d.inboundId) ? d.at : undefined);
    if (at) out.set(instant(at), d.status);
  }
  return out;
}

export type TranscriptMessage = ConversationState["messages"][number] & { notSent?: "dry_run" | "failed" };

/** The transcript as it truly happened: every message, with BARRY's undelivered ones marked (never presented as said). */
export function truthfulTranscript(state: Pick<ConversationState, "messages" | "knownFields">): TranscriptMessage[] {
  const undelivered = undeliveredMessages(state.knownFields);
  return state.messages.map((m) => {
    const notSent = m.role === "barry" ? undelivered.get(instant(m.at)) : undefined;
    return notSent ? { ...m, notSent } : m;
  });
}

/** The last message the customer could actually see or wrote (undelivered BARRY messages skipped). */
export function lastSaid(state: Pick<ConversationState, "messages" | "knownFields">): ConversationState["messages"][number] | undefined {
  const undelivered = undeliveredMessages(state.knownFields);
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role === "barry" && undelivered.has(instant(m.at))) continue;
    return m;
  }
  return undefined;
}

// ── Ledger (read side) ──────────────────────────────────────────────────────────────────────────

/**
 * The ledger as the owner may read it. The ledger itself is append-only and never rewritten; LEGACY
 * follow-up entries recorded a dry run as `followup.sent` — the conversation's delivery record for that
 * attempt says what really happened, so they read as `followup.dry_run` (or `followup.failed`).
 */
export function truthfulLedger(state: Pick<ConversationState, "knownFields">): LedgerEntry[] {
  const deliveries = readDeliveryList(state.knownFields);
  return readLedger(state as ConversationState).map((e) => {
    if (e.effect !== "followup.sent" || !e.reference) return e;
    const d = deliveries.find((x) => x.inboundId === e.reference);
    if (d?.status === "dry_run") return { ...e, effect: "followup.dry_run", status: "no_effect" };
    if (d?.status === "failed") return { ...e, effect: "followup.failed", status: "failed" };
    return e;
  });
}
