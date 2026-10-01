import { NextResponse, type NextRequest } from "next/server";

/**
 * Tells HQ pages which path was requested (request header `x-barry-path`), so a missing / expired founder
 * session can send the founder to login AND back to the exact page afterwards (requireFounder → /hq/login?next=).
 * It decides nothing about auth itself: every HQ page and API still checks the session on the server.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-barry-path", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/hq/:path*"] };
