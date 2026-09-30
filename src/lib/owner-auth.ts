import crypto from "node:crypto";
import { isProductionRuntime } from "@/lib/env";

/**
 * Guard for owner-only API routes (owner dashboard, Train BARRY, Learn Business, Connections, QA tools).
 *
 * Credentials (environment; never rendered, never in source):
 *  - BARRY_OWNER_TOKENS = "businessId:token,businessId2:token2" — per-business owner access (least
 *    privilege for design partners): a token opens ONLY its own business.
 *  - BARRY_OWNER_TOKEN — one operator token for every business (internal/testing).
 * In production at least one must be configured; locally and in tests the routes are open when neither
 * is set, so the simulator keeps working.
 *
 * A request is authorized by the token itself (header) or by an OWNER SESSION cookie created by signing in
 * once: `<businessId>.<expiry>.<hmac>`, the HMAC keyed by that business's own token (so rotating the token
 * ends its sessions) — the token never reaches the browser's storage. A session opens only its business
 * ("*" for the operator token).
 */

export const OWNER_COOKIE = "barry_owner";
const SESSION_HOURS = 12;

function equal(a: string, b: string): boolean {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

export function perBusinessTokens(): Map<string, string> {
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

export function ownerAccessConfigured(): boolean {
  return Boolean(process.env.BARRY_OWNER_TOKEN) || perBusinessTokens().size > 0;
}

/** Which businesses have their own owner token (ids only). */
export function businessesWithOwnerAccess(): string[] {
  return [...perBusinessTokens().keys()];
}

export function presentedOwnerToken(req: Request): string {
  return req.headers.get("x-barry-owner-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function sign(key: string, data: string): string {
  return crypto.createHmac("sha256", key).update(data).digest("base64url");
}

/** The key a session for this scope is signed with (the scope's own token). */
function sessionKey(scope: string): string | undefined {
  return scope === "*" ? process.env.BARRY_OWNER_TOKEN || undefined : perBusinessTokens().get(scope);
}

export type OwnerSignIn =
  | { ok: true; scope: "business" | "operator"; cookie: string; maxAge: number }
  | { ok: false; reason: "not_configured" | "wrong_business" | "invalid" };

/** Exchange a token for a session on ONE business. A token of another business is refused (and said so). */
export function ownerSignIn(businessId: string, token: string, now = Date.now()): OwnerSignIn {
  if (!ownerAccessConfigured()) return { ok: false, reason: "not_configured" };
  const global = process.env.BARRY_OWNER_TOKEN;
  const scopedToken = perBusinessTokens().get(businessId);
  const scope = global && equal(token, global) ? "*" : scopedToken && equal(token, scopedToken) ? businessId : undefined;
  if (!scope) {
    const otherBusiness = [...perBusinessTokens().entries()].some(([id, t]) => id !== businessId && equal(token, t));
    return { ok: false, reason: otherBusiness ? "wrong_business" : "invalid" };
  }
  const exp = now + SESSION_HOURS * 3600 * 1000;
  const data = `${scope}.${exp}`;
  return { ok: true, scope: scope === "*" ? "operator" : "business", cookie: `${data}.${sign(sessionKey(scope)!, data)}`, maxAge: SESSION_HOURS * 3600 };
}

/** The business scope of a valid session cookie ("*" = operator), or undefined. */
export function ownerSessionScope(req: Request, now = Date.now()): string | undefined {
  const value = cookieValue(req, OWNER_COOKIE);
  if (!value) return undefined;
  const parts = value.split(".");
  if (parts.length < 3) return undefined;
  const sig = parts.pop()!;
  const exp = Number(parts.pop());
  const scope = parts.join(".");
  const key = sessionKey(scope);
  if (!key || !Number.isFinite(exp) || exp < now) return undefined;
  return equal(sig, sign(key, `${scope}.${exp}`)) ? scope : undefined;
}

export function ownerAuthError(req: Request, businessId?: string): Response | undefined {
  if (!ownerAccessConfigured()) {
    return isProductionRuntime() ? Response.json({ error: "Owner access is not configured", code: "owner_access_not_configured" }, { status: 503 }) : undefined;
  }
  const presented = presentedOwnerToken(req);
  const global = process.env.BARRY_OWNER_TOKEN;
  const scoped = perBusinessTokens();
  if (presented) {
    if (global && equal(presented, global)) return undefined;
    if (businessId && scoped.has(businessId) && equal(presented, scoped.get(businessId)!)) return undefined;
  }
  const session = ownerSessionScope(req);
  if (session && (session === "*" || session === businessId)) return undefined;
  return Response.json({ error: session ? "You're signed in to a different business." : "Sign in as this business's owner.", code: session ? "wrong_business" : "unauthorized" }, { status: 401 });
}
