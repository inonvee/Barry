import { getBusinessGraph } from "@/lib/fixtures";
import type { BusinessGraph } from "@/lib/business-graph";
import { LearnBusinessInputError } from "./service";

export function graphOrNull(businessId: string | null | undefined): BusinessGraph | null {
  if (!businessId) return null;
  try {
    return getBusinessGraph(businessId);
  } catch {
    return null;
  }
}

/** Input errors are the owner's to fix (400); anything else is logged and returned generically. */
export function learnErrorResponse(err: unknown): Response {
  if (err instanceof LearnBusinessInputError) return Response.json({ error: err.message }, { status: 400 });
  console.error("[barry:learn-business]", err);
  return Response.json({ error: "Learn Business request failed" }, { status: 500 });
}
