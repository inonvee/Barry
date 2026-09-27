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
