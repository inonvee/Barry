/**
 * Sanitized, secret-free failure diagnostics for the LLM reasoner. Every
 * OpenAI/JSON/Zod/semantic failure gets classified and logged here instead
 * of being silently swallowed — so a broken integration is visible in
 * server logs, not just "BARRY gave a generic reply" with no trace of why.
 */
export type ReasonerFailureKind =
  | "openai_api_error"
  | "json_parse_error"
  | "schema_validation_error"
  | "semantic_validation_error";

const SECRET_KEY_PATTERN = /key|token|secret|authorization|password/i;

function sanitize(detail: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SECRET_KEY_PATTERN.test(k)) continue;
    clean[k] = v;
  }
  return clean;
}

export function logReasonerFailure(kind: ReasonerFailureKind, detail: Record<string, unknown>): void {
  console.error(`[barry:reasoner:${kind}]`, JSON.stringify(sanitize(detail)));
}
