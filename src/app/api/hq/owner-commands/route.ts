import { hqAuthError } from "@/lib/hq/auth";
import { fleetTenant } from "@/lib/hq/fleet";
import { listCommandRecords } from "@/lib/owner/command-service";
import { listOperations } from "@/lib/owner/operations";
import { listBriefs } from "@/lib/owner/briefs";

/**
 * FOUNDER ONLY — the owner command inspector for one business: every owner command with its structured
 * trace (identity → business → intent → state → grounding → entitlement → authority → plan → approval →
 * execution → verification → reply → delivery), the operations and the proactive briefs. Structured
 * steps only; no chain-of-thought, no full phone numbers, no tokens.
 */
export async function GET(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const businessId = new URL(req.url).searchParams.get("businessId") ?? "";
  const graph = fleetTenant(businessId);
  if (!graph) return Response.json({ error: "Unknown business" }, { status: 404 });
  const [commands, operations, briefs] = await Promise.all([listCommandRecords(businessId), listOperations(businessId), listBriefs(businessId)]);
  return Response.json({
    commands: commands.filter((c) => !c.key.startsWith("pending:")).slice(0, 50),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    operations: operations.slice(0, 20).map(({ actionToken, ...o }) => o),
    briefs: briefs.slice(0, 50),
  });
}
