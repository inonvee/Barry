import { NextResponse } from "next/server";
import { z } from "zod";
import { hqAuthError } from "@/lib/hq/auth";
import { fleetTenant } from "@/lib/hq/fleet";
import { setIncidentState } from "@/lib/hq/incidents";

const Body = z.object({ businessId: z.string().min(1), key: z.string().min(1), action: z.enum(["acknowledge", "resolve", "reopen"]), note: z.string().max(300).optional() });

/** Founder acknowledges / resolves / reopens an incident (durable, with who/when/note). */
export async function POST(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const type = req.headers.get("content-type") ?? "";
  const raw = type.includes("application/json") ? await req.json().catch(() => ({})) : Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "businessId, key and action are required" }, { status: 400 });
  const graph = fleetTenant(parsed.data.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  const state = await setIncidentState(graph.business.id, parsed.data.key, parsed.data.action, { by: "founder", note: parsed.data.note?.trim() || undefined });
  if (type.includes("application/json")) return Response.json({ state });
  return NextResponse.redirect(new URL(`/hq/${encodeURIComponent(graph.business.id)}#incidents`, req.url), 303);
}
