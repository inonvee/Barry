import { NextResponse } from "next/server";
import { HQ_COOKIE, founderTokenMatches, hqConfig, hqCookieOptions, issueHqSession } from "@/lib/hq/auth";

/** Founder sign-in: exchanges the founder token for a short-lived signed session cookie. */
export async function POST(req: Request) {
  if (!hqConfig().enabled) return Response.json({ error: "Not found" }, { status: 404 });
  let token = "";
  try {
    const form = await req.formData();
    token = String(form.get("token") ?? "");
  } catch {
    token = "";
  }
  if (!founderTokenMatches(token)) {
    return NextResponse.redirect(new URL("/hq/login?error=1", req.url), 303);
  }
  const session = issueHqSession();
  const res = NextResponse.redirect(new URL("/hq", req.url), 303);
  res.cookies.set(HQ_COOKIE, session.value, hqCookieOptions(session.maxAge));
  return res;
}
