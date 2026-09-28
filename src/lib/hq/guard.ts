import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { HQ_COOKIE, hqConfig, hqSessionValid } from "./auth";

/** For HQ pages: 404 when HQ is disabled, login when there is no valid founder session. */
export async function requireFounder(): Promise<void> {
  // Decided per request, never at build time: a page prerendered while HQ
  // was disabled (or enabled) must not outlive that configuration.
  await connection();
  if (!hqConfig().enabled) notFound();
  const session = (await cookies()).get(HQ_COOKIE)?.value;
  if (!hqSessionValid(session)) redirect("/hq/login");
}
