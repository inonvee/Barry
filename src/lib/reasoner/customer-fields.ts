/**
 * Central contract for what counts as a REAL customer-info value in
 * `BarryIR.customerInfo`. Live bug: a strict-JSON-schema Reasoner (LLM or
 * otherwise) sometimes has to supply *some* string for a key/value pair
 * even when it has nothing new to report — the schema has no way to
 * express "omit this pair" — and can literalize a sentinel string like
 * "null" instead of actually omitting the key. That sentinel then
 * persisted into ConversationState.knownFields verbatim, even though the
 * SAME turn's `entities` (display-only, never persisted) correctly held
 * the real value.
 *
 * This is the ONE place any reasoner's customerInfo value is normalized
 * before it's ever allowed to touch persistent ConversationState —
 * regardless of which reasoner produced it, and regardless of the field
 * name (arbitrary custom customer-info fields stay supported; this only
 * ever inspects the VALUE, never the key).
 */
const SENTINEL_VALUES = new Set([
  "null",
  "undefined",
  "none",
  "n/a",
  "na",
  "nil",
  "unknown",
  "not provided",
  "not specified",
  "not set",
]);

/**
 * Returns the real value, or `undefined` if it's empty/whitespace-only or
 * a known sentinel string a hallucinating/uncertain model might emit in
 * place of actually omitting the field. Callers must never merge an
 * `undefined` result into persistent state — that means "no update," not
 * "clear the existing value."
 */
export function normalizeCustomerFieldValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (SENTINEL_VALUES.has(trimmed.toLowerCase())) return undefined;
  return value;
}

export function isValidPhoneValue(value: string): boolean {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return false;
  if (/^0+$/.test(digits)) return false;
  if (trimmed.includes("+") && !trimmed.startsWith("+")) return false;
  return true;
}

/**
 * Values that can never be a person's own name (relationship words,
 * fillers, time words). This validates a VALUE before it persists — like
 * phone validation — it is not language understanding: it never produces
 * a name, it only refuses to store one of these as one.
 */
const IMPOSSIBLE_NAME_VALUES = new Set([
  "זה", "הוא", "היא",
  "אשתי", "אישתי", "בעלי", "בן הזוג", "בת הזוג", "בן זוגי", "בת זוגי",
  "wife", "husband", "partner", "spouse", "girlfriend", "boyfriend",
  "my wife", "my husband", "my partner",
  "tomorrow", "today", "tonight", "later",
]);

export function normalizeCustomerInfoField(key: string, value: string): string | undefined {
  const normalized = normalizeCustomerFieldValue(value);
  if (normalized === undefined) return undefined;
  if (key.toLowerCase() === "phone" && !isValidPhoneValue(normalized)) return undefined;
  if (key.toLowerCase() === "name" && IMPOSSIBLE_NAME_VALUES.has(normalized.trim().replace(/\s+/g, " ").toLowerCase())) return undefined;
  return normalized;
}
