import { NextResponse } from "next/server";
import { HQ_COOKIE, hqCookieOptions } from "@/lib/hq/auth";

export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL("/hq/login", req.url), 303);
  res.cookies.set(HQ_COOKIE, "", hqCookieOptions(0));
  return res;
}
