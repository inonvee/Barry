import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerAuthError } from "@/lib/owner-auth";
import { graphOrNull, learnErrorResponse } from "@/lib/learn-business/http";
import { listSources, revokeSource } from "@/lib/learn-business/sources";
import { intakeCatalog, intakeConnectedSystems, intakeDocument, intakeStructuredFacts } from "@/lib/learn-business/intake";
import { trainBarryView } from "@/lib/learn-business/train";

/** Owner-approved sources: list, intake (facts / document / systems / catalog), revoke. Owner session only. */
export async function GET(req: NextRequest) {
  const businessId = req.nextUrl.searchParams.get("businessId") ?? undefined;
  const denied = ownerAuthError(req, businessId);
  if (denied) return denied;
  const graph = graphOrNull(businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  return Response.json({ sources: await listSources(graph.business.id) });
}

const Body = z.discriminatedUnion("type", [
  z.object({ type: z.literal("owner_facts"), businessId: z.string().min(1), facts: z.array(z.object({ key: z.string().max(64), value: z.string().max(1000) })).min(1).max(50), approved: z.literal(true), approvedBy: z.string().max(200).default("owner") }),
  z.object({ type: z.literal("document"), businessId: z.string().min(1), name: z.string().min(1).max(120), text: z.string().min(1).max(400_000), approved: z.literal(true), approvedBy: z.string().max(200).default("owner") }),
  z.object({ type: z.literal("connected_system"), businessId: z.string().min(1), approved: z.literal(true), approvedBy: z.string().max(200).default("owner") }),
  z.object({ type: z.literal("catalog"), businessId: z.string().min(1), approved: z.literal(true), approvedBy: z.string().max(200).default("owner") }),
  z.object({ type: z.literal("revoke"), businessId: z.string().min(1), sourceId: z.string().min(1) }),
]);

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const denied = ownerAuthError(req, parsed.success ? parsed.data.businessId : undefined);
  if (denied) return denied;
  if (!parsed.success) return Response.json({ error: "Invalid source intake: the owner must approve exactly what BARRY reads" }, { status: 400 });
  const graph = graphOrNull(parsed.data.businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  try {
    const d = parsed.data;
    const result =
      d.type === "owner_facts" ? await intakeStructuredFacts({ graph, facts: d.facts, approvedBy: d.approvedBy })
      : d.type === "document" ? await intakeDocument({ graph, name: d.name, text: d.text, approvedBy: d.approvedBy })
      : d.type === "connected_system" ? await intakeConnectedSystems({ graph, approvedBy: d.approvedBy })
      : d.type === "catalog" ? await intakeCatalog({ graph, approvedBy: d.approvedBy })
      : { source: await revokeSource(graph.business.id, d.sourceId) };
    return Response.json({ result, train: await trainBarryView(graph) });
  } catch (err) {
    return learnErrorResponse(err);
  }
}
