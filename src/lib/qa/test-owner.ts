import { isProductionRuntime } from "@/lib/env";
import { TEST_BUSINESS_IDS, isDemoBusiness } from "@/lib/fixtures";
import { ownerSignIn, perBusinessTokens, type OwnerSignIn } from "@/lib/owner-auth";
import { getBackend } from "@/lib/store";
import { qaEnabled } from "./mode";

/**
 * TEST-OWNER SESSION BOOTSTRAP (Preview / QA mode only): signs the tester in as a TEST business's owner
 * through the existing session mechanism — the owner token never leaves the server and is never shown.
 *
 *  - Unavailable on Vercel Production and whenever QA mode is off (404).
 *  - Only for the test / demo fixture businesses, and only when that business has its OWN owner token
 *    configured (the operator token is never used, so no session can open another business).
 *  - Can be disabled per environment with BARRY_QA_TEST_OWNER_SIGNIN=0.
 *  - Every sign-in is recorded as a founder-visible audit entry (who: qa, which business, when).
 */
export type TestOwnerAvailability = { available: boolean; reason?: string; businesses: string[] };

export function testOwnerAvailability(): TestOwnerAvailability {
  if (process.env.VERCEL_ENV === "production" || (!qaEnabled() && isProductionRuntime())) return { available: false, reason: "not available on Production", businesses: [] };
  if (!qaEnabled()) return { available: false, reason: "QA mode is off", businesses: [] };
  if (process.env.BARRY_QA_TEST_OWNER_SIGNIN === "0") return { available: false, reason: "disabled for this environment (BARRY_QA_TEST_OWNER_SIGNIN=0)", businesses: [] };
  const tokens = perBusinessTokens();
  const businesses = [...tokens.keys()].filter((id) => TEST_BUSINESS_IDS.includes(id) || isDemoBusiness(id));
  return { available: true, businesses };
}

export async function testOwnerSignIn(businessId: string): Promise<OwnerSignIn | { ok: false; reason: "unavailable" | "not_test_business" | "no_own_token" }> {
  const availability = testOwnerAvailability();
  if (!availability.available) return { ok: false, reason: "unavailable" };
  if (!(TEST_BUSINESS_IDS.includes(businessId) || isDemoBusiness(businessId))) return { ok: false, reason: "not_test_business" };
  const token = perBusinessTokens().get(businessId);
  if (!token) return { ok: false, reason: "no_own_token" };
  const result = ownerSignIn(businessId, token);
  if (result.ok) {
    const at = new Date().toISOString();
    await getBackend().upsertOperatorRecord({ businessId, kind: "audit", key: `qa_signin_${Date.parse(at).toString(36)}_${Math.random().toString(36).slice(2, 6)}`, data: { id: `qa_${at}`, at, by: "qa:test-owner-signin", reason: "QA test-owner sign-in (Preview/QA mode)", change: {}, before: {}, after: {} } }).catch(() => undefined);
  }
  return result;
}
