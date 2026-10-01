import { hqAuthError } from "@/lib/hq/auth";
import { getFleet, fleetTenantIds } from "@/lib/hq/fleet";
import { searchFleet, searchBusinessRecords, type SearchResult } from "@/lib/hq/search";
import { getBackend } from "@/lib/store";
import { getConversationStore } from "@/lib/state";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";

/**
 * Command-bar search over the founder's scope (the whole fleet): businesses, incidents, conversations,
 * approvals, payments. Founder session only. Nothing outside the fleet's tenants is read.
 */
export async function GET(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) return Response.json({ results: [] });
  const fleet = await getFleet();
  const results: SearchResult[] = searchFleet(q, fleet, 8);
  const backend = getBackend();
  for (const id of fleetTenantIds()) {
    if (results.length >= 14) break;
    const graph = resolveBusinessGraph(id);
    const [conversations, approvals, payments] = await Promise.all([
      getConversationStore().listByBusiness(id).catch(() => []),
      backend.listApprovals(id).catch(() => []),
      backend.listPaymentRequests(id).catch(() => []),
    ]);
    const base = `/hq/${encodeURIComponent(id)}`;
    results.push(
      ...searchBusinessRecords(q, {
        businessId: id,
        businessName: graph.business.name,
        conversations,
        approvals,
        payments,
        hrefs: { conversation: (cid) => `${base}/conversations/${encodeURIComponent(cid)}`, approval: (a) => `${base}/conversations/${encodeURIComponent(a.conversationId)}`, payment: (p) => `${base}/conversations/${encodeURIComponent(p.conversationId)}` },
      }, 6)
    );
  }
  return Response.json({ results: results.slice(0, 14) });
}
