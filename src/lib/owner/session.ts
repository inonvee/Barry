import { getBackend } from "@/lib/store";
import type { OwnerLang } from "./lang";

/**
 * THE OWNER'S CONVERSATIONAL CONTEXT — what a short reply ("yes", "send that", "tell her…", "give it back")
 * refers to. One durable record per owner identity per business, written only by the command service.
 *
 *  - It names exactly ONE thing at a time (the request just shown, the customer just discussed, the
 *    operation just proposed) plus at most one reply draft waiting for "send".
 *  - It expires: after CONTEXT_TTL_MS of silence it reads as empty — an old "yes" never acts.
 *  - A new, unrelated request replaces it, so a later "yes" can't land on an earlier action.
 *  - It is a pointer, never authority: whatever it points at is re-read and re-checked (approval revision,
 *    who holds the conversation, the operating mode) before anything executes.
 */

export const CONTEXT_TTL_MS = 15 * 60_000;

export type OwnerFocus =
  | { kind: "approval"; approvalId: string; promptKey: string; customer: string; conversationId: string }
  | { kind: "conversation"; conversationId: string; customer: string }
  | { kind: "operation"; opId: string };

export type ReplyDraft = { conversationId: string; customer: string; text: string; requestId: string; at: string };

export type OwnerSession = { key: string; businessId: string; actor: string; focus?: OwnerFocus; draft?: ReplyDraft; lang?: OwnerLang; updatedAt: string };

const sessionKey = (actor: string) => `session:${actor}`;

/** The owner's current context — empty when there is none or it has expired. */
export async function loadSession(businessId: string, actor: string, now = new Date()): Promise<OwnerSession> {
  const key = sessionKey(actor);
  const r = (await getBackend().listOperatorRecords(businessId, "owner_command")).find((x) => x.key === key);
  const s = r?.data as unknown as OwnerSession | undefined;
  if (!s || now.getTime() - Date.parse(s.updatedAt) > CONTEXT_TTL_MS) return { key, businessId, actor, ...(s?.lang ? { lang: s.lang } : {}), updatedAt: now.toISOString() };
  return s;
}

export async function saveSession(s: OwnerSession, now = new Date()): Promise<void> {
  await getBackend().upsertOperatorRecord({ businessId: s.businessId, kind: "owner_command", key: s.key, data: { ...s, updatedAt: now.toISOString() } as unknown as Record<string, unknown> });
}

/** Records that are not commands (the owner session, a pending business choice). */
export const isContextRecordKey = (key: string) => key.startsWith("session:") || key.startsWith("pending:") || key.startsWith("link:");
