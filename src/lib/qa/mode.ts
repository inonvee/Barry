/**
 * QA MODE — test-only tools (forced understanding failure, simulated WhatsApp inbound, status strip).
 *
 *  - Vercel Production (VERCEL_ENV=production): ALWAYS off. Nothing can turn it on.
 *  - Any other production-mode runtime that isn't a Vercel Preview: off.
 *  - Vercel Preview: on, unless BARRY_QA_MODE=0.
 *  - Local development / tests: on, unless BARRY_QA_MODE=0.
 * Every QA action is additionally gated by owner access to the business it touches.
 */
export function qaEnabled(): boolean {
  if (process.env.VERCEL_ENV === "production") return false;
  if (process.env.BARRY_QA_MODE === "0") return false;
  if (process.env.VERCEL_ENV === "preview") return true;
  return process.env.NODE_ENV !== "production";
}

export function environmentLabel(): "production" | "preview" | "development" | "test" {
  if (process.env.VERCEL_ENV === "production") return "production";
  if (process.env.VERCEL_ENV === "preview") return "preview";
  return process.env.NODE_ENV === "test" ? "test" : process.env.NODE_ENV === "production" ? "production" : "development";
}

/** One-shot: the next customer message in THIS conversation fails understanding (stored with the conversation). */
export const QA_FORCE_UNDERSTANDING_FAILURE = "__qaForceUnderstandingFailure";
