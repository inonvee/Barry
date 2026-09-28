import crypto from "node:crypto";
import { isProductionRuntime } from "@/lib/env";

/**
 * Guard for owner-only API routes (Learn Business, Connections). In
 * production an owner token MUST be configured (BARRY_OWNER_TOKEN) and
 * presented; locally and in tests the routes are open when no token is
 * set, so the simulator keeps working.
 */
export function ownerAuthError(req: Request): Response | undefined {
  const expected = process.env.BARRY_OWNER_TOKEN;
  if (!expected) {
    return isProductionRuntime()
      ? Response.json({ error: "Owner access is not configured" }, { status: 503 })
      : undefined;
  }
  const header = req.headers.get("x-barry-owner-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = crypto.createHash("sha256").update(header).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b) ? undefined : Response.json({ error: "Unauthorized" }, { status: 401 });
}
