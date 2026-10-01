import { NextResponse } from "next/server";
import { z } from "zod";
import { hqAuthError } from "@/lib/hq/auth";
import { activateProposal, decideProposal, listProposals, proposeChange, rollbackProposal } from "@/lib/hq/proposals";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("propose"), instruction: z.string().min(3).max(1000), scope: z.enum(["GLOBAL", "CAPABILITY", "BUSINESS", "TEMPORARY"]), businessIds: z.union([z.array(z.string()), z.string()]).optional(), capability: z.string().max(120).optional(), until: z.string().max(40).optional(), mode: z.enum(["simulator", "supervised", "live", ""]).optional(), pauseConsequentialWrites: z.union([z.boolean(), z.enum(["true", "false", ""])]).optional(), approvalRequiredForAll: z.union([z.boolean(), z.enum(["true", "false", ""])]).optional(), safeMode: z.union([z.boolean(), z.enum(["true", "false", ""])]).optional(), pausedBusiness: z.union([z.boolean(), z.enum(["true", "false", ""])]).optional(), disabledChannels: z.union([z.array(z.string()), z.string()]).optional(), pausedCapabilities: z.union([z.array(z.string()), z.string()]).optional() }),
  z.object({ action: z.literal("approve"), id: z.string().min(1), note: z.string().max(300).optional() }),
  z.object({ action: z.literal("reject"), id: z.string().min(1), note: z.string().max(300).optional() }),
  z.object({ action: z.literal("activate"), id: z.string().min(1), confirm: z.union([z.literal("yes"), z.literal(true)]) }),
  z.object({ action: z.literal("rollback"), id: z.string().min(1), confirm: z.union([z.literal("yes"), z.literal(true)]) }),
]);

const bool = (v: boolean | "true" | "false" | "" | undefined) => (v === undefined || v === "" ? undefined : v === true || v === "true");
const list = (v: string[] | string | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean));

/** Ask HQ V2: structured change proposals — propose, approve / reject, activate (gated by scope), roll back. Founder only. */
export async function GET(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  return Response.json({ proposals: await listProposals() });
}

export async function POST(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const type = req.headers.get("content-type") ?? "";
  const raw = type.includes("application/json") ? await req.json().catch(() => ({})) : Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "Invalid proposal request" }, { status: 400 });
  const d = parsed.data;
  try {
    const result =
      d.action === "propose"
        ? { proposal: await proposeChange({ instruction: d.instruction, scope: d.scope, businessIds: list(d.businessIds), capability: d.capability || undefined, until: d.until || undefined, by: "founder", change: { ...(d.mode ? { mode: d.mode as "simulator" | "supervised" | "live" } : {}), ...(bool(d.pauseConsequentialWrites) !== undefined ? { pauseConsequentialWrites: bool(d.pauseConsequentialWrites) } : {}), ...(bool(d.approvalRequiredForAll) !== undefined ? { approvalRequiredForAll: bool(d.approvalRequiredForAll) } : {}), ...(bool(d.safeMode) !== undefined ? { safeMode: bool(d.safeMode) } : {}), ...(bool(d.pausedBusiness) !== undefined ? { pausedBusiness: bool(d.pausedBusiness) } : {}), ...(list(d.disabledChannels)?.length ? { disabledChannels: list(d.disabledChannels) } : {}), ...(list(d.pausedCapabilities)?.length ? { pausedCapabilities: list(d.pausedCapabilities) } : {}) } }) }
        : d.action === "approve" || d.action === "reject"
          ? { proposal: await decideProposal({ id: d.id, decision: d.action === "approve" ? "approved" : "rejected", by: "founder", note: d.note }) }
          : d.action === "activate"
            ? await activateProposal({ id: d.id, by: "founder" })
            : await rollbackProposal({ id: d.id, by: "founder" });
    if (type.includes("application/json")) return Response.json(result);
    return NextResponse.redirect(new URL("/hq/proposals", req.url), 303);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "proposal failed" }, { status: 400 });
  }
}
