import crypto from "node:crypto";

/** Vercel Cron's `Authorization: Bearer $CRON_SECRET`. Unset / short secret → never authorized (never open). */
export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || secret.length < 16 || !bearer) return false;
  const h = (s: string) => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(h(bearer), h(secret));
}
