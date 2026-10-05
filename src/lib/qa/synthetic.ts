/**
 * QA-OWNED SYNTHETIC ARTIFACTS — how BARRY knows, deterministically and without timing, that a record was made by an
 * acceptance run and must never reach a real person (e.g. the founder's proactive WhatsApp alerts):
 *
 *   - synthetic phone numbers start with 999 (no real E.164 number does: country code 999 is unassigned) — every QA
 *     runner uses them for owners, founders and customers, from the very first message;
 *   - QA conversations are additionally stamped `__qaAcceptance` by the runners.
 *
 * Nothing real is ever classified as QA by these rules, so no real incident is suppressed.
 */
export const SYNTHETIC_NUMBER_PREFIX = "999";
export const QA_STAMP_KEY = "__qaAcceptance";

export function isSyntheticNumber(value: string | undefined | null): boolean {
  return Boolean(value) && String(value).replace(/\D/g, "").startsWith(SYNTHETIC_NUMBER_PREFIX);
}

/** A conversation id of a synthetic channel user (`wa:<business>:999…`). */
export function isQaConversationId(id: string | undefined | null): boolean {
  const m = id?.match(/^wa:[^:]+:(.+)$/);
  return Boolean(m && isSyntheticNumber(m[1]));
}

/** A conversation an acceptance run owns: synthetic number, or explicitly stamped by a QA runner. */
export function isQaConversation(c: { id: string; knownFields?: Record<string, string> }): boolean {
  return isQaConversationId(c.id) || Boolean(c.knownFields?.[QA_STAMP_KEY]);
}
