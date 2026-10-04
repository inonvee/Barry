import { perBusinessTokens } from "@/lib/owner-auth";

/**
 * GUARDS FOR THE IN-DEPLOYMENT PREVIEW ACCEPTANCE RUNNER (TEMPORARY QA SURFACE).
 *
 * The runner drives the deployment's own routes with the deployment's own secrets, so it may only ever run on
 * the isolated Preview: VERCEL_ENV must be exactly "preview", the database must be the Preview branch project,
 * WhatsApp sending must be explicitly "dry_run", and the Production database ref is refused outright. Anything
 * else → the route answers 404 (it does not exist). Values are never echoed — only names of what is missing.
 */

export const PREVIEW_DB_PROJECT = "glqrfoljvdbyrmbvupym";
export const PRODUCTION_DB_PROJECT = "ynnmlsnmybbaxeyolydj";

export function databaseProjectRef(url = process.env.SUPABASE_URL): string | null {
  try {
    return url ? new URL(url).hostname.split(".")[0] : null;
  } catch {
    return null;
  }
}

/** null = this deployment may run the acceptance; otherwise why not (never a secret value). */
export function previewAcceptanceRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.VERCEL_ENV !== "preview") return "not a Vercel Preview deployment";
  const db = databaseProjectRef(env.SUPABASE_URL);
  if (db === PRODUCTION_DB_PROJECT) return "the deployment points at the Production database";
  if (db !== PREVIEW_DB_PROJECT) return "the deployment is not on the Preview database";
  if (!env.SUPABASE_SERVICE_ROLE_KEY?.trim()) return "durable storage is not configured";
  if (env.BARRY_WHATSAPP_SEND !== "dry_run") return "WhatsApp sending is not explicitly dry_run";
  return null;
}

/** The deployment's own credentials the runner needs (names only when missing). */
export function acceptanceCredentials(businessId: string, env: NodeJS.ProcessEnv = process.env): { ok: true; appSecret: string; ownerToken: string; founderToken: string; cronSecret: string } | { ok: false; missing: string[] } {
  const ownerToken = env.BARRY_OWNER_TOKEN?.trim() || perBusinessTokens().get(businessId) || "";
  const parts = { WHATSAPP_APP_SECRET: env.WHATSAPP_APP_SECRET?.trim() ?? "", "owner token": ownerToken, BARRY_FOUNDER_TOKEN: env.BARRY_FOUNDER_TOKEN?.trim() ?? "", CRON_SECRET: env.CRON_SECRET?.trim() ?? "" };
  const missing = Object.entries(parts).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { ok: false, missing };
  return { ok: true, appSecret: parts.WHATSAPP_APP_SECRET, ownerToken, founderToken: parts.BARRY_FOUNDER_TOKEN, cronSecret: parts.CRON_SECRET };
}

/** The routed test phone_number_id for the acceptance business (from BARRY_WHATSAPP_ROUTES). */
export function routedPhoneNumberId(businessId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const pair of (env.BARRY_WHATSAPP_ROUTES ?? "").split(",")) {
    const [pnid, biz] = pair.split("=").map((s) => s?.trim());
    if (pnid && biz === businessId) return pnid;
  }
  return null;
}
