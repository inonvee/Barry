import { NextResponse } from "next/server";
import { HQ_COOKIE, founderTokenMatches, hqConfig, hqCookieOptions, issueHqSession, safeHqNext } from "@/lib/hq/auth";

/**
 * Founder sign-in: exchanges the founder token for a short-lived signed session cookie, then lands on the HQ
 * page that was asked for (`next`, validated to an HQ path) — one exchange, one redirect.
 */
export async function POST(req: Request) {
  if (!hqConfig().enabled) return Response.json({ error: "Not found" }, { status: 404 });
  let token = "";
  let next = "/hq";
  try {
    const form = await req.formData();
    token = String(form.get("token") ?? "");
    next = safeHqNext(String(form.get("next") ?? ""));
  } catch {
    token = "";
  }
  if (!founderTokenMatches(token)) {
    return NextResponse.redirect(new URL(`/hq/login?error=1${next === "/hq" ? "" : `&next=${encodeURIComponent(next)}`}`, req.url), 303);
  }
  const session = issueHqSession();
  const res = NextResponse.redirect(new URL(next, req.url), 303);
  res.cookies.set(HQ_COOKIE, session.value, hqCookieOptions(session.maxAge));
  return res;
}
