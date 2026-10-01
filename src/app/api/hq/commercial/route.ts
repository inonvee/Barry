import { NextResponse } from "next/server";
import { z } from "zod";
import { hqAuthError } from "@/lib/hq/auth";
import { fleetTenant, fleetTenantIds } from "@/lib/hq/fleet";
import { loadControls } from "@/lib/hq/controls";
import { launchChecklist } from "@/lib/hq/launch";
import { activateFreePeriod, addCommercialNote, cancelSubscription, CommercialError, confirmRecurringStart, emulatePlanForQa, getCommercialAccount, invoiceSetup, markSetupPaid, pauseSubscription, quoteSetup, resumeSubscription, selectPlan, waiveSetup } from "@/lib/commercial/account";
import { commercialReadiness } from "@/lib/commercial/readiness";
import { recordCost, recordSupportTime } from "@/lib/commercial/cost";
import { getCommercialBusiness, getCommercialFleet } from "@/lib/commercial/service";
import { runCommercialQaScenario, COMMERCIAL_QA_SCENARIOS, type CommercialQaScenarioId } from "@/lib/qa/commercial-scenarios";
import type { BusinessGraph } from "@/lib/business-graph";

/**
 * HQ COMMERCIAL — founder only (HQ session or founder bearer). Every change is a commercial event with
 * who / when / why / before → after, made through the vendor-neutral (manual) billing boundary. Nothing
 * here charges anyone. Free-month activation recomputes the readiness gate on the server.
 */

export async function GET(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const businessId = new URL(req.url).searchParams.get("businessId");
  if (businessId) {
    const graph = fleetTenant(businessId);
    if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
    return Response.json(await getCommercialBusiness(graph));
  }
  const graphs = fleetTenantIds().map((id) => fleetTenant(id)).filter((g): g is BusinessGraph => !!g);
  return Response.json(await getCommercialFleet(graphs));
}

const num = z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/).transform(Number)]);
const bool = z.union([z.boolean(), z.enum(["true", "false", "on", "yes"]).transform((v) => v !== "false")]);

const Body = z.object({
  businessId: z.string().min(1),
  action: z.enum(["select_plan", "quote_setup", "invoice_setup", "mark_setup_paid", "waive_setup", "activate_free_period", "confirm_recurring", "pause", "resume", "cancel", "note", "record_cost", "record_support", "qa_emulate_plan", "qa_scenario"]),
  reason: z.string().max(500).optional().default(""),
  confirm: z.union([z.literal("yes"), z.literal(true)]).optional(),
  plan: z.enum(["CORE", "OPERATOR", "INTELLIGENCE", "CUSTOM", "NONE"]).optional(),
  monthlyPrice: num.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  setupPrice: num.optional(),
  foundingCustomer: bool.optional(),
  priceLockMonths: num.optional(),
  confirmFeatureRemoval: bool.optional(),
  reference: z.string().max(200).optional(),
  override: z.string().max(500).optional(),
  effectiveAt: z.string().optional(),
  note: z.string().max(2000).optional(),
  minutes: num.optional(),
  cost: z.record(z.string(), z.unknown()).optional(),
  scenario: z.string().optional(),
});

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const form = await req.formData();
  const out: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && v !== "") out[k] = v;
  if (typeof out.costJson === "string") {
    try {
      out.cost = JSON.parse(out.costJson as string);
    } catch {
      /* validated below */
    }
  }
  if (out.costCategory) {
    out.cost = { category: out.costCategory, provider: out.costProvider, amount: out.costBasis === "unavailable" ? null : Number(out.costAmount), currency: out.costCurrency ?? "USD", basis: out.costBasis, source: out.costSource, periodStart: out.costPeriodStart ? new Date(String(out.costPeriodStart)).toISOString() : undefined, periodEnd: out.costPeriodEnd ? new Date(String(out.costPeriodEnd)).toISOString() : undefined, ...(out.costConfidence ? { confidence: out.costConfidence } : {}) };
  }
  return out;
}

const CONSEQUENTIAL = new Set(["select_plan", "mark_setup_paid", "waive_setup", "activate_free_period", "confirm_recurring", "pause", "resume", "cancel"]);

export async function POST(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const raw = await readBody(req);
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json") || (req.headers.get("content-type") ?? "").includes("application/json");
  const parsed = Body.safeParse(raw);
  const back = (businessId: string, q: Record<string, string>) => NextResponse.redirect(new URL(`/hq/commercial/${encodeURIComponent(businessId)}?${new URLSearchParams(q)}`, req.url), 303);
  if (!parsed.success) return Response.json({ error: "Invalid commercial request", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const b = parsed.data;
  const graph = fleetTenant(b.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  const id = graph.business.id;
  if (CONSEQUENTIAL.has(b.action) && (!b.confirm || b.reason.trim().length < 3)) {
    const error = "A reason and an explicit confirmation are required.";
    return wantsJson ? Response.json({ error }, { status: 400 }) : back(id, { error });
  }
  const meta = { by: "founder", reason: b.reason.trim() || b.action.replace(/_/g, " ") };
  try {
    let result: unknown;
    switch (b.action) {
      case "select_plan":
        if (!b.plan || b.plan === "NONE") throw new CommercialError("Choose a plan");
        result = await selectPlan(id, { plan: b.plan, ...(b.monthlyPrice !== undefined ? { monthlyPrice: b.monthlyPrice } : {}), ...(b.currency ? { currency: b.currency } : {}), ...(b.setupPrice !== undefined ? { setupPrice: b.setupPrice } : {}), ...(b.foundingCustomer !== undefined ? { foundingCustomer: b.foundingCustomer } : {}), ...(b.priceLockMonths ? { priceLockMonths: b.priceLockMonths } : {}), ...(b.confirmFeatureRemoval ? { confirmFeatureRemoval: true } : {}), source: "hq" }, meta);
        break;
      case "quote_setup":
        if (b.setupPrice === undefined) throw new CommercialError("A setup price is required");
        result = await quoteSetup(id, { setupPrice: b.setupPrice }, meta);
        break;
      case "invoice_setup":
        result = await invoiceSetup(id, meta);
        break;
      case "mark_setup_paid":
        result = await markSetupPaid(id, { ...(b.reference ? { reference: b.reference } : {}) }, meta);
        break;
      case "waive_setup":
        result = await waiveSetup(id, meta);
        break;
      case "activate_free_period": {
        // The gate is recomputed here — the client never says "ready".
        const controls = await loadControls(id);
        const readiness = commercialReadiness({ account: await getCommercialAccount(id), launch: await launchChecklist(graph, { controls }), controls });
        result = await activateFreePeriod(id, { gateLevel: readiness.level, ...(readiness.blocker ? { gateBlocker: readiness.blocker } : {}), ...(b.override?.trim() ? { override: b.override.trim() } : {}) }, meta);
        break;
      }
      case "confirm_recurring":
        result = await confirmRecurringStart(id, meta);
        break;
      case "pause":
        result = await pauseSubscription(id, meta);
        break;
      case "resume":
        result = await resumeSubscription(id, meta);
        break;
      case "cancel":
        result = await cancelSubscription(id, { ...(b.effectiveAt ? { effectiveAt: new Date(b.effectiveAt).toISOString() } : {}) }, meta);
        break;
      case "note":
        result = await addCommercialNote(id, b.note ?? b.reason, { by: "founder" });
        break;
      case "record_cost":
        result = await recordCost(id, b.cost ?? {}, "founder");
        break;
      case "record_support":
        if (!b.minutes) throw new CommercialError("Minutes are required");
        result = await recordSupportTime(id, { minutes: b.minutes, note: b.note ?? b.reason }, "founder");
        break;
      case "qa_emulate_plan":
        await emulatePlanForQa(id, b.plan && b.plan !== "NONE" ? b.plan : null, "founder");
        result = { emulated: b.plan ?? null };
        break;
      case "qa_scenario": {
        if (!COMMERCIAL_QA_SCENARIOS.some((s) => s.id === b.scenario)) throw new CommercialError("Unknown QA scenario");
        result = await runCommercialQaScenario(b.scenario as CommercialQaScenarioId);
        if (!wantsJson) {
          const r = result as { outcome: string; failures: string[] };
          return back(id, { ok: `QA ${b.scenario}: ${r.outcome.toUpperCase()}${r.failures.length ? ` — ${r.failures.join("; ")}` : ""}` });
        }
        break;
      }
    }
    return wantsJson ? Response.json({ ok: true, result }) : back(id, { ok: `${b.action.replace(/_/g, " ")} recorded` });
  } catch (err) {
    const error = err instanceof CommercialError || err instanceof z.ZodError ? (err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err.message) : err instanceof Error ? err.message : "failed";
    return wantsJson ? Response.json({ error }, { status: 409 }) : back(id, { error });
  }
}
