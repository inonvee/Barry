import { ownerAuthError } from "@/lib/owner-auth";
import { graphOrNull } from "@/lib/learn-business/http";
import type { BusinessGraph } from "@/lib/business-graph";

/** Owner API guard: the caller must hold this business's owner access; the business must exist. */
export function ownerGraph(req: Request, businessId: string | null | undefined): { graph: BusinessGraph } | { error: Response } {
  const denied = ownerAuthError(req, businessId ?? undefined);
  if (denied) return { error: denied };
  const graph = graphOrNull(businessId);
  if (!graph) return { error: Response.json({ error: "Unknown business" }, { status: 404 }) };
  return { graph };
}

export function ownerFailure(where: string, err: unknown): Response {
  console.error(`[barry:owner] ${where}`, err instanceof Error ? err.message : err);
  return Response.json({ error: "Something went wrong loading this. Please try again." }, { status: 500 });
}
