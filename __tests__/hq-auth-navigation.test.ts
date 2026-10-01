import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as sessionPost } from "@/app/api/hq/session/route";
import { GET as cronGet, POST as cronPost } from "@/app/api/cron/initiative-scan/route";
import { HQ_COOKIE, hqCookieOptions, hqSessionValid, issueHqSession, safeHqNext } from "@/lib/hq/auth";
import { proxy, config as proxyConfig } from "@/proxy";
import { NextRequest } from "next/server";

/**
 * HQ AUTH / NAVIGATION (live failure: opening an HQ link from another app bounced a signed-in founder to
 * login; signing in always landed on /hq, so the founder re-opened the link and looped). Fix: Lax session
 * cookie, `next` carried through login and validated to an HQ path, one session exchange, cookie-only GETs
 * never act.
 */
const TOKEN = "founder-test-token-that-is-long-enough-123456";
beforeEach(() => {
  process.env.BARRY_FOUNDER_TOKEN = TOKEN;
});
afterEach(() => {
  delete process.env.CRON_SECRET;
});

const form = (fields: Record<string, string>) => {
  const body = new URLSearchParams(fields);
  return new Request("https://barry.example/api/hq/session", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
};

describe("session cookie", () => {
  it("is Lax (survives a top-level link from another site), httpOnly, path /, 12h", () => {
    const o = hqCookieOptions(issueHqSession().maxAge);
    expect(o.sameSite).toBe("lax");
    expect(o.httpOnly).toBe(true);
    expect(o.path).toBe("/");
    expect(o.maxAge).toBe(12 * 3600);
  });

  it("expires and dies with token rotation", () => {
    const s = issueHqSession(Date.now()).value;
    expect(hqSessionValid(s)).toBe(true);
    expect(hqSessionValid(s, Date.now() + 13 * 3600_000)).toBe(false);
    process.env.BARRY_FOUNDER_TOKEN = "a-different-founder-token-that-is-long-enough";
    expect(hqSessionValid(s)).toBe(false);
  });
});

describe("where sign-in lands", () => {
  it("only an HQ path on this site; everything else falls back to /hq", () => {
    expect(safeHqNext("/hq/commercial/fashion-retailer")).toBe("/hq/commercial/fashion-retailer");
    expect(safeHqNext("/hq/ask?q=hi")).toBe("/hq/ask?q=hi");
    expect(safeHqNext("/hq")).toBe("/hq");
    for (const bad of ["", "https://evil.example/hq", "//evil.example/hq", "/hqevil", "/owner", "/api/hq/controls", "/hq/login", "/hq/login?next=/hq", "/hq\\..\\x", `/hq/${"a".repeat(600)}`, "/hq/\u0000"]) expect(safeHqNext(bad), bad).toBe("/hq");
  });

  it("valid token → ONE 303 straight to the requested page with the session cookie", async () => {
    const res = await sessionPost(form({ token: TOKEN, next: "/hq/commercial/fashion-retailer" }));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/hq/commercial/fashion-retailer");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${HQ_COOKIE}=`));
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).not.toContain(TOKEN);
  });

  it("invalid token is rejected, keeps the destination, sets no cookie", async () => {
    const res = await sessionPost(form({ token: "wrong-token-wrong-token-wrong-token", next: "/hq/commercial/fashion-retailer" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/\/hq\/login\?error=1&next=%2Fhq%2Fcommercial%2Ffashion-retailer$/);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("a hostile next can't redirect off-site", async () => {
    const res = await sessionPost(form({ token: TOKEN, next: "//evil.example/hq" }));
    expect(new URL(res.headers.get("location")!).toString()).toBe("https://barry.example/hq");
  });

  it("the proxy passes the requested HQ path to the page guard (and only runs on /hq)", () => {
    const res = proxy(new NextRequest("https://barry.example/hq/commercial/fashion-retailer?x=1"));
    expect(res.headers.get("x-middleware-request-x-barry-path")).toBe("/hq/commercial/fashion-retailer?x=1");
    expect(proxyConfig.matcher).toEqual(["/hq/:path*"]);
  });
});

describe("cookie-only GETs never act", () => {
  it("the scheduler tick refuses a cookie-only GET (reachable from another site's link) but accepts the founder cookie on POST", async () => {
    const session = issueHqSession().value;
    const cookie = { cookie: `${HQ_COOKIE}=${session}` };
    expect((await cronGet(new Request("https://barry.example/api/cron/initiative-scan?businessId=fashion-retailer&at=2026-12-01T06:00:00Z", { headers: cookie }))).status).toBe(401);
    const post = await cronPost(new Request("https://barry.example/api/cron/initiative-scan?businessId=fashion-retailer&at=2026-12-01T06:00:00Z", { method: "POST", headers: cookie }));
    expect(post.status).toBe(200);
    // Founder bearer token on GET is unchanged.
    expect((await cronGet(new Request("https://barry.example/api/cron/initiative-scan?businessId=fashion-retailer&at=2026-12-01T06:00:00Z", { headers: { authorization: `Bearer ${TOKEN}` } }))).status).toBe(200);
  });
});
