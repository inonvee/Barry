import { z } from "zod";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { actOnInitiative, applyInitiativeAction } from "@/lib/initiative/engine";
import { listScans, visibleInitiatives } from "@/lib/initiative/store";
import { toView } from "@/lib/initiative/model";

/** The owner's initiatives (what BARRY noticed) — read only; nothing is detected on read. */
export async function GET(req: Request) {
  const g = ownerGraph(req, new URL(req.url).searchParams.get("businessId"));
  if ("error" in g) return g.error;
  try {
    const [initiatives, scans] = await Promise.all([visibleInitiatives(g.graph.business.id), listScans(g.graph.business.id)]);
    return Response.json({ initiatives, lastScan: scans.find((s) => !s.skipped)?.at ?? null });
  } catch (err) {
    return ownerFailure("initiatives", err);
  }
}

const Body = z.object({
  businessId: z.string().min(1),
  id: z.string().min(3),
  action: z.enum(["review", "accept", "dismiss", "snooze", "invalid", "act"]),
  days: z.number().int().min(1).max(30).optional(),
  reason: z.string().max(200).optional(),
  requestId: z.string().min(8).max(80).optional(),
  lang: z.enum(["en", "he"]).optional(),
});

/**
 * Owner actions on an initiative. "act" is NOT a shortcut: it runs the initiative's recommended command
 * through the SAME owner command service as the command bar / WhatsApp (plan → authority → grounding →
 * execution → verification → idempotency), then links the result for measurement.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const g = ownerGraph(req, parsed.success ? parsed.data.businessId : undefined);
  if ("error" in g) return g.error;
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { id, action } = parsed.data;
  const businessId = g.graph.business.id;
  try {
    if (action !== "act") {
      const i = await applyInitiativeAction(businessId, id, action === "snooze" ? { kind: "snooze", days: parsed.data.days ?? 7 } : action === "invalid" ? { kind: "invalid", reason: parsed.data.reason ?? "owner said it isn't right" } : { kind: action });
      return i ? Response.json({ initiative: toView(i) }) : Response.json({ error: "Not found" }, { status: 404 });
    }
    const r = await actOnInitiative(g.graph, id, parsed.data.requestId ?? new Date().toISOString(), parsed.data.lang ?? "en");
    if (!r.ok) return Response.json({ error: r.reason === "not_found" ? "Not found" : r.reason }, { status: r.reason === "not_found" ? 404 : 409 });
    return Response.json({ reply: r.reply });
  } catch (err) {
    return ownerFailure("initiative action", err);
  }
}
