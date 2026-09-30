import type { NextRequest } from "next/server";
import { z } from "zod";
import { OWNER_COOKIE, businessesWithOwnerAccess, ownerAccessConfigured, ownerAuthError, ownerSessionScope, ownerSignIn } from "@/lib/owner-auth";
import { isProductionRuntime } from "@/lib/env";
import { listBusinessSummaries } from "@/lib/fixtures";

/**
 * Owner sign-in for the owner workspace (test-friendly, not final auth): exchange a business's owner
 * token for a 12-hour httpOnly session on THAT business. Nothing secret is ever returned.
 */

function setupHelp() {
  const ids = listBusinessSummaries().map((b) => b.id);
  return {
    variable: "BARRY_OWNER_TOKENS",
    shape: `${ids.slice(0, 3).map((id) => `${id}:<random-token-32+chars>`).join(",")}`,
    note: "Set it for the Preview environment only (one random token per business; never reuse the founder token). Redeploy after setting.",
    businessIds: ids,
  };
}

export async function GET(req: NextRequest) {
  const businessId = req.nextUrl.searchParams.get("businessId") ?? undefined;
  const configured = ownerAccessConfigured();
  const scope = ownerSessionScope(req);
  const open = !configured && !isProductionRuntime();
  return Response.json({
    configured,
    open,
    signedIn: open || Boolean(scope),
    scope: open ? "open" : scope === "*" ? "operator" : scope ? "business" : null,
    businessId: scope && scope !== "*" ? scope : null,
    authorized: businessId ? !ownerAuthError(req, businessId) : null,
    businessesWithAccess: businessesWithOwnerAccess(),
    ...(configured ? {} : { setup: setupHelp() }),
  });
}

const Body = z.object({ businessId: z.string().min(1), token: z.string().min(1).max(500) });

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Choose a business and enter its owner token." }, { status: 400 });
  const result = ownerSignIn(parsed.data.businessId, parsed.data.token.trim());
  if (!result.ok) {
    if (result.reason === "not_configured") return Response.json({ error: "Owner access is not configured for this environment.", code: "owner_access_not_configured", setup: setupHelp() }, { status: 503 });
    if (result.reason === "wrong_business") return Response.json({ error: "That token belongs to a different business.", code: "wrong_business" }, { status: 403 });
    return Response.json({ error: "That token isn't valid.", code: "invalid" }, { status: 401 });
  }
  const res = Response.json({ signedIn: true, scope: result.scope, businessId: parsed.data.businessId });
  res.headers.append("set-cookie", `${OWNER_COOKIE}=${encodeURIComponent(result.cookie)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${result.maxAge}${isProductionRuntime() ? "; Secure" : ""}`);
  return res;
}

export async function DELETE() {
  const res = Response.json({ signedIn: false });
  res.headers.append("set-cookie", `${OWNER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isProductionRuntime() ? "; Secure" : ""}`);
  return res;
}
