import { z } from "zod";
import { hqAuthError } from "@/lib/hq/auth";
import { fleetTenant } from "@/lib/hq/fleet";
import { BusinessNumberError, allBusinessNumbers, registerBusinessNumber, setNumberStatus } from "@/lib/channels/business-numbers";

/**
 * BUSINESS CUSTOMER WHATSAPP NUMBERS (founder / BARRY team). Where a completed Meta onboarding (Embedded Signup) lands:
 * the business's phone_number_id + WABA id become durable configuration for THAT business — no code edit, no redeploy.
 *
 *   GET  /api/hq/whatsapp-numbers                          every business's customer number (ids + state, no secrets)
 *   POST { action: "register", businessId, phoneNumberId, wabaId, displayPhone?, coexistence?, credentialRef? }
 *   POST { action: "status", businessId, phoneNumberId, status: connected|disconnected|token_expired, reason }
 *
 * The Meta authorization itself (Embedded Signup, token exchange, webhook field subscription) is an external step.
 * `credentialRef` names where a token lives (e.g. an environment variable) — a token value is never accepted here.
 */
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("register"), businessId: z.string().min(1), phoneNumberId: z.string().min(3).max(64), wabaId: z.string().min(3).max(64), displayPhone: z.string().max(20).optional(), coexistence: z.enum(["not_requested", "pending_verification", "unavailable"]).optional(), credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).optional() }).strict(),
  z.object({ action: z.literal("status"), businessId: z.string().min(1), phoneNumberId: z.string().min(3).max(64), status: z.enum(["connected", "disconnected", "token_expired"]), reason: z.string().min(3).max(300) }).strict(),
]);

export async function GET(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  return Response.json({ numbers: (await allBusinessNumbers()).map(({ history, ...n }) => ({ ...n, changes: history.length })) });
}

export async function POST(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const b = parsed.data;
  if (!fleetTenant(b.businessId)) return Response.json({ error: "Unknown business" }, { status: 404 });
  try {
    // "verified" coexistence is never set by hand: only a received echo proves it.
    if (b.action === "register") return Response.json(await registerBusinessNumber({ ...b, by: "founder (HQ)" }));
    return Response.json(await setNumberStatus(b.businessId, b.phoneNumberId, b.status, "founder (HQ)", b.reason));
  } catch (err) {
    if (err instanceof BusinessNumberError) return Response.json({ error: err.message, code: err.code }, { status: err.code === "not_found" ? 404 : 409 });
    throw err;
  }
}
