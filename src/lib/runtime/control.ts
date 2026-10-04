import type { ConversationState } from "@/lib/state";
import { readHandoffs, HANDOFFS_KEY, type HandoffRecord } from "./handoff";

/**
 * WHO HOLDS THE CONVERSATION — the one invariant of a human handoff:
 *
 *   When a person holds a conversation, BARRY does not reply to the customer on its own.
 *
 *   BARRY handling ──handoff / take over──► a person holds it ──(person replies, resolves)──► return to BARRY
 *
 * The holder is stored on the conversation (written only through the version-checked save, under the
 * conversation's lock), so it survives retries and redeploys and is the same for every channel and every
 * surface (web owner, owner WhatsApp, the customer's WhatsApp or web chat). Every change of holder is
 * appended to an audit log: who, from → to, why, when, and which handoff.
 *
 * Resolving a handoff closes the customer's issue; it does NOT give the conversation back to BARRY — only
 * an explicit return does (which also closes any handoff still open).
 */

export type ControlHolder = "barry" | "human";

export type ConversationControl = {
  holder: ControlHolder;
  since: string;
  /** Who made the change: "barry" (a runtime handoff) or the owner/team identity. */
  by: string;
  reason: string;
  handoffId?: string;
};

export type ControlEvent = { at: string; from: ControlHolder; to: ControlHolder; by: string; reason: string; handoffId?: string };

export const CONTROL_KEY = "__control";
export const CONTROL_LOG_KEY = "__controlLog";

function parse<T>(value: string | undefined, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The current holder. A conversation with no control record yet (legacy records) is held by a person while
 * a handoff is still open — the safe reading; otherwise by BARRY.
 */
export function readControl(state: Pick<ConversationState, "knownFields">): ConversationControl {
  const stored = parse<ConversationControl | null>(state.knownFields[CONTROL_KEY], null);
  if (stored && (stored.holder === "barry" || stored.holder === "human")) return stored;
  const open = readHandoffs(state as ConversationState).find((h) => h.status !== "resolved");
  if (open) return { holder: "human", since: open.createdAt, by: "barry", reason: open.reason, handoffId: open.id };
  return { holder: "barry", since: "", by: "barry", reason: "" };
}

/** True while a person holds the conversation: BARRY must not reply or reach out on its own. */
export function humanHolds(state: Pick<ConversationState, "knownFields">): boolean {
  return readControl(state).holder === "human";
}

export function readControlLog(state: Pick<ConversationState, "knownFields">): ControlEvent[] {
  const log = parse<ControlEvent[]>(state.knownFields[CONTROL_LOG_KEY], []);
  return Array.isArray(log) ? log : [];
}

function setControl(state: ConversationState, to: ControlHolder, by: string, reason: string, handoffId?: string): ConversationControl {
  const before = readControl(state);
  const at = new Date().toISOString();
  const next: ConversationControl = { holder: to, since: before.holder === to ? before.since || at : at, by, reason, ...(handoffId ? { handoffId } : {}) };
  state.knownFields[CONTROL_KEY] = JSON.stringify(next);
  if (before.holder !== to || !state.knownFields[CONTROL_LOG_KEY]) {
    const event: ControlEvent = { at, from: before.holder, to, by, reason, ...(handoffId ? { handoffId } : {}) };
    state.knownFields[CONTROL_LOG_KEY] = JSON.stringify([...readControlLog(state), event].slice(-100));
  }
  return next;
}

/** A person takes the conversation (a runtime handoff, or the owner's explicit take-over / reply). Idempotent. */
export function giveToHuman(state: ConversationState, by: string, reason: string, handoffId?: string): ConversationControl {
  const cur = readControl(state);
  if (cur.holder === "human" && state.knownFields[CONTROL_KEY]) return cur;
  return setControl(state, "human", by, reason, handoffId);
}

/**
 * The owner (or team) explicitly takes the conversation. Unlike `giveToHuman`, a conversation BARRY handed to
 * "a person" becomes held by THIS person (who, from when, why), and its open handoff is acknowledged by them.
 * Idempotent: taking a conversation you already hold changes nothing.
 */
export function takeOverBy(state: ConversationState, by: string, reason: string): ConversationControl {
  const cur = readControl(state);
  const all = readHandoffs(state);
  let acknowledged = false;
  for (const h of all) {
    if (h.status !== "open") continue;
    h.status = "acknowledged";
    h.acknowledgedAt = new Date().toISOString();
    h.resolvedBy = by;
    acknowledged = true;
  }
  if (acknowledged) state.knownFields[HANDOFFS_KEY] = JSON.stringify(all);
  if (cur.holder === "human" && state.knownFields[CONTROL_KEY] && cur.by === by) return cur;
  return setControl(state, "human", by, reason, cur.handoffId);
}

/** Explicit return to BARRY. Any handoff still open is closed (resolved by the same person). */
export function returnToBarry(state: ConversationState, by: string, reason = "returned to BARRY"): { control: ConversationControl; closed: HandoffRecord[] } {
  const all = readHandoffs(state);
  const at = new Date().toISOString();
  const closed: HandoffRecord[] = [];
  for (const h of all) {
    if (h.status === "resolved") continue;
    h.status = "resolved";
    h.resolvedAt = at;
    h.resolvedBy = by;
    closed.push(h);
  }
  if (closed.length) state.knownFields[HANDOFFS_KEY] = JSON.stringify(all);
  return { control: setControl(state, "barry", by, reason), closed };
}

// ── Owner replies: at most once per request ────────────────────────────────────────────────────────

export const OWNER_REPLIES_KEY = "__ownerReplies";

/**
 * One owner reply, keyed by the caller's request id. "sending" is persisted BEFORE the channel call, so a
 * retry of the same request never sends twice: it returns the recorded outcome, or "unknown" if the send was
 * interrupted (never re-sent).
 */
export type OwnerReplyRecord = { requestId: string; by: string; text: string; status: "sending" | "sent" | "dry_run" | "failed" | "unknown"; at: string; messageAt?: string; providerMessageId?: string; error?: string };

export function readOwnerReplies(state: Pick<ConversationState, "knownFields">): Record<string, OwnerReplyRecord> {
  const v = parse<Record<string, OwnerReplyRecord>>(state.knownFields[OWNER_REPLIES_KEY], {});
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export function writeOwnerReply(state: ConversationState, r: OwnerReplyRecord): void {
  const all = readOwnerReplies(state);
  all[r.requestId] = r;
  state.knownFields[OWNER_REPLIES_KEY] = JSON.stringify(Object.fromEntries(Object.entries(all).slice(-200)));
}
