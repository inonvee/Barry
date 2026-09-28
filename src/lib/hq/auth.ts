import crypto from "node:crypto";

/**
 * BARRY HQ is the founder's cross-tenant control plane: it can read every
 * business's Genome, readiness, operations and conversation traces. It is
 * therefore guarded more strictly than the per-business owner routes:
 *
 *  - HQ exists only when BARRY_FOUNDER_TOKEN is configured — in EVERY
 *    environment, including local dev and previews. Unset => every HQ page
 *    and API is a 404. There is no "open in dev" mode.
 *  - The founder token must be long (>= 32 chars) and must differ from the
 *    owner token, so an owner credential can never open cross-tenant data.
 *  - The browser holds a short-lived signed session (HMAC of the token and
 *    an expiry), never the token itself. Rotating the token ends sessions.
 */

export const HQ_COOKIE = "barry_hq";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MIN_TOKEN_LENGTH = 32;

export type HqConfig = { enabled: true; token: string } | { enabled: false; reason: string };

export function hqConfig(): HqConfig {
  const token = process.env.BARRY_FOUNDER_TOKEN?.trim();
  if (!token) return { enabled: false, reason: "BARRY_FOUNDER_TOKEN is not set" };
  if (token.length < MIN_TOKEN_LENGTH) return { enabled: false, reason: `BARRY_FOUNDER_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters` };
  if (token === process.env.BARRY_OWNER_TOKEN?.trim()) return { enabled: false, reason: "BARRY_FOUNDER_TOKEN must differ from BARRY_OWNER_TOKEN" };
  return { enabled: true, token };
}

function sign(token: string, expires: number): string {
  return crypto.createHmac("sha256", token).update(`barry-hq-session:v1:${expires}`).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Does the presented token match the configured founder token? False whenever HQ is disabled. */
export function founderTokenMatches(candidate: string | null | undefined): boolean {
  const config = hqConfig();
  if (!config.enabled || !candidate) return false;
  return safeEqual(candidate, config.token);
}

/** A new session cookie value (only after the token was checked). */
export function issueHqSession(now = Date.now()): { value: string; maxAge: number } {
  const config = hqConfig();
  if (!config.enabled) throw new Error("HQ is disabled");
  const expires = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  return { value: `${expires}.${sign(config.token, expires)}`, maxAge: SESSION_TTL_SECONDS };
}

export function hqSessionValid(value: string | null | undefined, now = Date.now()): boolean {
  const config = hqConfig();
  if (!config.enabled || !value) return false;
  const [expiresRaw, signature] = value.split(".");
  const expires = Number(expiresRaw);
  if (!Number.isInteger(expires) || !signature) return false;
  if (expires * 1000 <= now) return false;
  return safeEqual(signature, sign(config.token, expires));
}

export function hqCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge,
  };
}

function cookieFrom(req: Request): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === HQ_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/**
 * Guard for HQ API routes: 404 when HQ is disabled (it does not exist),
 * 401 without a valid founder session or founder bearer token.
 */
export function hqAuthError(req: Request): Response | undefined {
  if (!hqConfig().enabled) return Response.json({ error: "Not found" }, { status: 404 });
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && founderTokenMatches(bearer)) return undefined;
  if (hqSessionValid(cookieFrom(req))) return undefined;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
