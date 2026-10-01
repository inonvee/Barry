import type { BusinessGraph } from "@/lib/business-graph";
import type { CapabilityProfiles } from "@/lib/capabilities/model";
import type { CostEvidence } from "./impact";
import { costActionAuthority } from "./actions";

/**
 * NEGOTIATION PREPARATION — from verified supplier evidence only: purchase history, concentration,
 * price trend, alternatives (other suppliers of the same item), a target range (flagged as a
 * proposal), fallbacks and the owner-approved objective. BARRY never sends supplier communication
 * without a supported channel AND explicit authority; this returns a brief, not a message.
 */

export type NegotiationBrief = {
  counterparty: string;
  history: { purchases: number; total: number; currency: string; first: string; last: string; items: { item: string; quantity: number; lastUnitPrice: number | null; firstUnitPrice: number | null; trendPct: number | null }[] };
  concentration: { sharePct: number | null; basis: string };
  alternatives: { item: string; supplier: string; lastUnitPrice: number }[];
  targetRange: { item: string; low: number; high: number; basis: string }[];
  fallbacks: string[];
  objective: { text: string; approved: boolean };
  canSend: { ok: boolean; reasons: string[] };
};

const round = (n: number) => Math.round(n * 100) / 100;

export function prepareNegotiation(input: { graph: BusinessGraph; evidence: CostEvidence[]; counterparty: string; objective?: string; objectiveApproved?: boolean; profiles?: CapabilityProfiles }): NegotiationBrief {
  const verified = input.evidence.filter((e) => e.verified && e.kind === "supplier_cost");
  const mine = verified.filter((e) => (e.counterparty ?? "").toLowerCase() === input.counterparty.toLowerCase()).sort((a, b) => a.at.localeCompare(b.at));
  const currency = mine[0]?.currency ?? verified[0]?.currency ?? "USD";
  const total = round(mine.reduce((s, e) => s + e.amount, 0));
  const allSupplier = round(verified.filter((e) => e.currency === currency).reduce((s, e) => s + e.amount, 0));
  const byItem = new Map<string, CostEvidence[]>();
  for (const e of mine) if (e.item) byItem.set(e.item, [...(byItem.get(e.item) ?? []), e]);
  const items = [...byItem.entries()].map(([item, xs]) => {
    const first = xs.find((e) => e.unitPrice)?.unitPrice ?? null;
    const last = [...xs].reverse().find((e) => e.unitPrice)?.unitPrice ?? null;
    return { item, quantity: xs.reduce((n, e) => n + (e.quantity ?? 1), 0), lastUnitPrice: last, firstUnitPrice: first, trendPct: first && last ? round(((last - first) / first) * 100) : null };
  });
  const alternatives = verified.filter((e) => e.item && byItem.has(e.item) && (e.counterparty ?? "").toLowerCase() !== input.counterparty.toLowerCase() && e.unitPrice).map((e) => ({ item: e.item!, supplier: e.counterparty ?? "other supplier", lastUnitPrice: e.unitPrice! }));
  const targetRange = items.filter((i) => i.lastUnitPrice).map((i) => {
    const alt = alternatives.filter((a) => a.item === i.item).map((a) => a.lastUnitPrice);
    const low = round(Math.min(i.firstUnitPrice ?? i.lastUnitPrice!, ...(alt.length ? alt : [i.lastUnitPrice!])));
    return { item: i.item, low, high: round(i.lastUnitPrice! * 0.95), basis: alt.length ? "the earlier price and another supplier's verified price" : i.firstUnitPrice && i.firstUnitPrice < i.lastUnitPrice! ? "the earlier verified unit price" : "5% below the latest price — a proposal, not a quote" };
  });
  const messaging = input.profiles?.messaging;
  const authority = costActionAuthority(input.graph, "procurement.negotiation.open", { counterparty: input.counterparty, objective: input.objective ?? "", idempotencyKey: "preview-only-key" });
  const reasons: string[] = [];
  if (!messaging || messaging.status !== "connected") reasons.push("no supported channel to the supplier");
  if (authority.status !== "allowed") reasons.push(`authority: ${authority.status} — ${authority.reason}`);
  if (!input.objectiveApproved) reasons.push("the owner has not approved the negotiation objective");
  return {
    counterparty: input.counterparty,
    history: { purchases: mine.length, total, currency, first: mine[0]?.at ?? "", last: mine.at(-1)?.at ?? "", items },
    concentration: { sharePct: allSupplier ? round((total / allSupplier) * 100) : null, basis: "share of verified supplier cost in the same currency" },
    alternatives,
    targetRange,
    fallbacks: ["Split volume between suppliers", "Accept the current price with a shorter commitment", "Reduce reorder quantity and revisit next period"],
    objective: { text: input.objective ?? "", approved: Boolean(input.objectiveApproved) },
    canSend: { ok: reasons.length === 0, reasons },
  };
}
