import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { getOwnerPlanView, requestPlanChange } from "@/lib/commercial/service";

/**
 * OWNER PLAN + VALUE — what the owner bought, what BARRY can do, what is plan-locked, what an upgrade
 * unlocks, and what BARRY delivered this month. Never cost-to-serve, AI cost, margin or provider
 * economics (the view is an explicit allow-list). An upgrade is a REQUEST to the BARRY team only.
 */
export async function GET(req: NextRequest) {
  const g = ownerGraph(req, req.nextUrl.searchParams.get("businessId"));
  if ("error" in g) return g.error;
  try {
    return Response.json(await getOwnerPlanView(g.graph));
  } catch (err) {
    return ownerFailure("plan", err);
  }
}

const Body = z.object({ businessId: z.string().min(1), plan: z.enum(["CORE", "OPERATOR", "INTELLIGENCE", "CUSTOM"]).optional(), message: z.string().max(500).optional() });

export async function POST(req: NextRequest) {
  const raw = await req.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  const g = ownerGraph(req, parsed.success ? parsed.data.businessId : null);
  if ("error" in g) return g.error;
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  try {
    const request = await requestPlanChange(g.graph.business.id, { ...(parsed.data.plan ? { plan: parsed.data.plan } : {}), ...(parsed.data.message ? { message: parsed.data.message } : {}) }, "owner");
    return Response.json({ request, note: "The BARRY team will contact you. Nothing about your plan or billing changes until you agree it with them." });
  } catch (err) {
    return ownerFailure("plan request", err);
  }
}
