import { NextResponse } from "next/server";
import { hqAuthError } from "@/lib/hq/auth";
import { fleetTenant } from "@/lib/hq/fleet";
import { loadPins, savePins, togglePin } from "@/lib/hq/visits";

/** Pin / unpin a business on the founder's Focus (durable founder state). */
export async function POST(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const type = req.headers.get("content-type") ?? "";
  const raw: Record<string, unknown> = type.includes("application/json") ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  const graph = raw.businessId ? fleetTenant(String(raw.businessId)) : undefined;
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  const pins = togglePin(await loadPins(), graph.business.id);
  await savePins(pins);
  if (type.includes("application/json")) return Response.json({ pins });
  const back = typeof raw.back === "string" && raw.back.startsWith("/hq") ? raw.back : "/hq";
  return NextResponse.redirect(new URL(back, req.url), 303);
}
