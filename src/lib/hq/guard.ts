import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { HQ_COOKIE, hqConfig, hqSessionValid, safeHqNext } from "./auth";

/**
 * For HQ pages: 404 when HQ is disabled, login when there is no valid founder session — carrying the page
 * that was asked for (`next`, an HQ path only) so the founder lands back on it after signing in once.
 */
export async function requireFounder(): Promise<void> {
  // Decided per request, never at build time: a page prerendered while HQ
  // was disabled (or enabled) must not outlive that configuration.
  await connection();
  if (!hqConfig().enabled) notFound();
  const session = (await cookies()).get(HQ_COOKIE)?.value;
  if (hqSessionValid(session)) return;
  const next = safeHqNext((await headers()).get("x-barry-path"));
  redirect(next === "/hq" ? "/hq/login" : `/hq/login?next=${encodeURIComponent(next)}`);
}
