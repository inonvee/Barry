import { ownerAuthError } from "@/lib/owner-auth";

/**
 * CUSTOMER SIMULATOR ACCESS — the simulator routes read transcripts, speak as a customer and settle test
 * payments, so they are never a public surface:
 *
 *  - Vercel Production (VERCEL_ENV=production): the routes do not exist (404). Nothing can turn them on.
 *  - Any other production-mode runtime that isn't a Vercel Preview: 404 (fail closed).
 *  - Vercel Preview, local development and tests: available, but only to the owner of the business the
 *    request names (the same owner session / token as the owner APIs). Locally and in tests with no owner
 *    access configured the routes stay open, exactly like the owner APIs; on a Preview without owner access
 *    configured they answer 503 (ownerAuthError fails closed in every production-mode runtime).
 *
 * Settling a payment is additionally limited to simulated providers by the store itself
 * (simulatePaymentOutcome), so even a misconfigured gate can never create real, verified revenue.
 */
export function simulatorEnabled(): boolean {
  if (process.env.VERCEL_ENV === "production") return false;
  if (process.env.VERCEL_ENV === "preview") return true;
  return process.env.NODE_ENV !== "production";
}

/** undefined = allowed; otherwise the response to return. */
export function simulatorAccessError(req: Request, businessId: string | null | undefined): Response | undefined {
  if (!simulatorEnabled()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!businessId) return Response.json({ error: "businessId is required" }, { status: 400 });
  return ownerAuthError(req, businessId);
}
