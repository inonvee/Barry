import type { NextRequest } from "next/server";
import { z } from "zod";
import { OWNER_COOKIE } from "@/lib/owner-auth";
import { isProductionRuntime } from "@/lib/env";
import { testOwnerAvailability, testOwnerSignIn } from "@/lib/qa/test-owner";

/** QA ONLY: which test businesses can be signed into without a token (never the tokens themselves). */
export async function GET() {
  const a = testOwnerAvailability();
  if (!a.available && a.reason === "not available on Production") return new Response("Not found", { status: 404 });
  return Response.json(a);
}

const Body = z.object({ businessId: z.string().min(1) });

/** QA ONLY: sign in as a TEST business's owner. Issues the ordinary httpOnly owner session; reveals nothing. */
export async function POST(req: NextRequest) {
  const a = testOwnerAvailability();
  if (!a.available) return new Response("Not found", { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "businessId is required" }, { status: 400 });
  const result = await testOwnerSignIn(parsed.data.businessId);
  if (!result.ok) {
    const status = result.reason === "unavailable" ? 404 : result.reason === "not_test_business" ? 403 : 409;
    return Response.json({ error: result.reason === "not_test_business" ? "Only test businesses can be signed into this way." : result.reason === "no_own_token" ? "This business has no owner token configured for this environment (BARRY team: add one to the Preview settings)." : "Not available." }, { status });
  }
  const res = Response.json({ signedIn: true, scope: result.scope, businessId: parsed.data.businessId, testOnly: true });
  res.headers.append("set-cookie", `${OWNER_COOKIE}=${encodeURIComponent(result.cookie)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${result.maxAge}${isProductionRuntime() ? "; Secure" : ""}`);
  return res;
}
