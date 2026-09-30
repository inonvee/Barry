import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerAuthError } from "@/lib/owner-auth";
import { qaEnabled } from "@/lib/qa/mode";
import { QA_SCENARIOS, listQaScenarioRuns, runQaScenario, type QaScenarioId } from "@/lib/qa/scenarios";

/** QA ONLY: list scenarios (and this business's runs) / run one. Owner access to the business required. */
export async function GET(req: NextRequest) {
  if (!qaEnabled()) return new Response("Not found", { status: 404 });
  const businessId = req.nextUrl.searchParams.get("businessId") ?? undefined;
  const runs = businessId && !ownerAuthError(req, businessId) ? await listQaScenarioRuns(businessId).catch(() => []) : [];
  return Response.json({ scenarios: QA_SCENARIOS, runs });
}

const Body = z.object({ businessId: z.string().min(1), scenario: z.string().min(1) });

export async function POST(req: NextRequest) {
  if (!qaEnabled()) return new Response("Not found", { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const denied = ownerAuthError(req, parsed.success ? parsed.data.businessId : undefined);
  if (denied) return denied;
  if (!parsed.success) return Response.json({ error: "businessId and scenario are required" }, { status: 400 });
  const scenario = QA_SCENARIOS.find((s) => s.id === parsed.data.scenario);
  if (!scenario) return Response.json({ error: "Unknown scenario" }, { status: 404 });
  if (scenario.businessId !== parsed.data.businessId) return Response.json({ error: `This scenario belongs to ${scenario.businessId}` }, { status: 400 });
  try {
    const run = await runQaScenario(scenario.id as QaScenarioId);
    return Response.json({ run });
  } catch (err) {
    console.error("[barry:qa] scenario failed", err instanceof Error ? err.message : err);
    return Response.json({ error: err instanceof Error ? err.message.slice(0, 300) : "scenario failed" }, { status: 500 });
  }
}
