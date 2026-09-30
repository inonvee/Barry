import crypto from "node:crypto";
import { isProductionRuntime } from "@/lib/env";

/**
 * Guard for owner-only API routes (owner dashboard, Learn Business, Connections).
 *
 * Two configurations, both secret-free in responses:
 *  - BARRY_OWNER_TOKENS = "businessId:token,businessId2:token2" — per-business owner access (least
 *    privilege for design partners): a token opens ONLY its own business. When set, a request for a
 *    business must present that business's token.
 *  - BARRY_OWNER_TOKEN — one operator token for every business (internal/testing).
 * In production at least one must be configured; locally and in tests the routes are open when neither
 * is set, so the simulator keeps working.
 */

function equal(a: string, b: string): boolean {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

function perBusinessTokens(): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (process.env.BARRY_OWNER_TOKENS ?? "").split(",")) {
    const i = pair.indexOf(":");
    if (i <= 0) continue;
    const id = pair.slice(0, i).trim();
    const token = pair.slice(i + 1).trim();
    if (id && token.length >= 16) map.set(id, token);
  }
  return map;
}

export function presentedOwnerToken(req: Request): string {
  return req.headers.get("x-barry-owner-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

export function ownerAuthError(req: Request, businessId?: string): Response | undefined {
  const global = process.env.BARRY_OWNER_TOKEN;
  const scoped = perBusinessTokens();
  if (!global && scoped.size === 0) {
    return isProductionRuntime() ? Response.json({ error: "Owner access is not configured" }, { status: 503 }) : undefined;
  }
  const presented = presentedOwnerToken(req);
  if (global && equal(presented, global)) return undefined;
  if (businessId && scoped.has(businessId) && equal(presented, scoped.get(businessId)!)) return undefined;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
