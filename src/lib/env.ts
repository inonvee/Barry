/**
 * Production must never silently pretend AI or persistence is active when
 * it isn't. `next build`/`next start` and every Vercel deployment
 * (preview or production) set NODE_ENV=production; `next dev` sets
 * "development" and `vitest` sets "test" — so this cleanly distinguishes
 * "a real deployment" from "local dev / the test suite" without a new,
 * easy-to-forget env var of its own.
 */
export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

export class BarryConfigurationError extends Error {
  constructor(message: string) {
    super(`BARRY production configuration error: ${message}`);
    this.name = "BarryConfigurationError";
  }
}
