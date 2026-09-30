import { NextResponse } from "next/server";
import { z } from "zod";
import { hqAuthError } from "@/lib/hq/auth";
import { fleetTenant } from "@/lib/hq/fleet";
import { applyControlChange } from "@/lib/hq/controls";

/**
 * FOUNDER CONTROL — bounded, confirmed, audited, reversible. Founder session or bearer token only.
 * Accepts a form (HQ page) or JSON. Every change needs a reason and an explicit confirmation.
 */
const Body = z.object({
  businessId: z.string().min(1),
  reason: z.string().min(3).max(500),
  confirm: z.union([z.literal("yes"), z.literal(true)]),
  mode: z.enum(["simulator", "supervised", "live"]).optional(),
  pauseConsequentialWrites: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
  approvalRequiredForAll: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
  pausedCapabilities: z.union([z.array(z.string()), z.string()]).optional(),
  disabledChannels: z.union([z.array(z.string()), z.string()]).optional(),
});

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const form = await req.formData();
  const out: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? v : "";
  return out;
}

const list = (v: string[] | string | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean));
const bool = (v: boolean | "true" | "false" | undefined) => (v === undefined ? undefined : v === true || v === "true");

export async function POST(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const raw = await readBody(req);
  const parsed = Body.safeParse(raw);
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json") || (req.headers.get("content-type") ?? "").includes("application/json");
  if (!parsed.success) return Response.json({ error: "A business, a reason and an explicit confirmation are required." }, { status: 400 });
  const graph = fleetTenant(parsed.data.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  const { controls, audit } = await applyControlChange(
    graph.business.id,
    {
      ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
      ...(bool(parsed.data.pauseConsequentialWrites) !== undefined ? { pauseConsequentialWrites: bool(parsed.data.pauseConsequentialWrites) } : {}),
      ...(bool(parsed.data.approvalRequiredForAll) !== undefined ? { approvalRequiredForAll: bool(parsed.data.approvalRequiredForAll) } : {}),
      ...(list(parsed.data.pausedCapabilities) !== undefined ? { pausedCapabilities: list(parsed.data.pausedCapabilities) } : {}),
      ...(list(parsed.data.disabledChannels) !== undefined ? { disabledChannels: list(parsed.data.disabledChannels) } : {}),
    },
    { by: "founder", reason: parsed.data.reason }
  );
  if (wantsJson) return Response.json({ controls, audit });
  return NextResponse.redirect(new URL(`/hq/${encodeURIComponent(graph.business.id)}#controls`, req.url), 303);
}
