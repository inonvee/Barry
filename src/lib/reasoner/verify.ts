import type { BusinessGraph } from "@/lib/business-graph";
import type { DateSpec, SchedulingConstraint } from "@/lib/scheduling/resolver";
import { findOffersByExplicitNameReference, extractExplicitSchedulingConstraint } from "./entities";
import type { BarryIR } from "./ir";

/**
 * Deterministic semantic verification, sitting between ANY Reasoner's
 * (LLM or mock) BarryIR and the compiler:
 *
 *   customer text + Reasoner's BarryIR -> verifyIR() -> normalized BarryIR -> compiler
 *
 * The model understands fuzzy language; this is the ONE place BARRY
 * cross-checks high-confidence, directly-verifiable business semantics —
 * offer references and explicit weekday/relative-day tokens — against
 * the raw customer text, and overrides the Reasoner when its IR
 * contradicts something the customer plainly, verifiably said. It is
 * NOT a replacement for the Reasoner: it only acts when its OWN
 * deterministic check produces a confident, unambiguous answer;
 * otherwise the Reasoner's own (possibly more nuanced) judgment stands
 * untouched. It never computes a final UTC instant — that remains
 * `resolveSchedulingWindow()`'s job, called only from the compiler.
 */
export type IRVerification = {
  llmSelectedOfferId?: string;
  llmOfferCandidateIds?: string[];
  llmSchedulingWindow?: SchedulingConstraint;
  offerOverridden: boolean;
  schedulingOverridden: boolean;
};

function dateSpecsMatch(a: DateSpec | undefined, b: DateSpec): boolean {
  if (!a || a.kind !== b.kind) return false;
  switch (b.kind) {
    case "weekday":
      return a.kind === "weekday" && a.weekday === b.weekday && (a.qualifier ?? undefined) === (b.qualifier ?? undefined);
    case "relativeDay":
      return a.kind === "relativeDay" && a.days === b.days;
    case "explicitDate":
      return a.kind === "explicitDate" && a.isoDate === b.isoDate;
  }
}

export function verifyIR(graph: BusinessGraph, customerMessage: string, ir: BarryIR): { verified: BarryIR; verification: IRVerification } {
  const verification: IRVerification = {
    llmSelectedOfferId: ir.selectedOfferId,
    llmOfferCandidateIds: ir.offerCandidateIds,
    llmSchedulingWindow: ir.constraints.schedulingWindow,
    offerOverridden: false,
    schedulingOverridden: false,
  };

  // --- Offer reference verification ---
  // If the raw text confidently and unambiguously names exactly one
  // offer (by its own name — never a description word, to avoid
  // false-positive overrides on incidental overlap), that deterministic
  // read wins, whether the Reasoner was ambiguous (multiple candidates)
  // or confidently wrong (a single, different selection). A tie (0 or
  // 2+ matches) means the raw text alone can't decide it — the
  // Reasoner's own judgment (which may use conversation context this
  // simple matcher can't see) stands untouched.
  let selectedOfferId = ir.selectedOfferId;
  let offerCandidateIds = ir.offerCandidateIds;

  const explicitOfferMatches = findOffersByExplicitNameReference(graph, customerMessage);
  if (explicitOfferMatches.length === 1) {
    const confidentId = explicitOfferMatches[0].id;
    if (selectedOfferId !== confidentId || (offerCandidateIds && offerCandidateIds.length > 0)) {
      verification.offerOverridden = true;
    }
    selectedOfferId = confidentId;
    offerCandidateIds = undefined;
  }

  // --- Scheduling date verification ---
  // If the raw text contains a directly-verifiable explicit weekday or
  // relative-day token ("Tuesday", "next Monday", "tomorrow", "today")
  // and the Reasoner's date disagrees (wrong kind, wrong weekday number,
  // wrong qualifier, wrong day offset), the explicit token wins. The
  // Reasoner's TIME reading is kept when present — it may have parsed
  // "3pm" correctly even while botching the date — falling back to
  // whatever the deterministic extractor found only if the Reasoner
  // gave no time at all.
  let schedulingWindow = ir.constraints.schedulingWindow;
  const explicitWindow = extractExplicitSchedulingConstraint(customerMessage);
  if (explicitWindow?.date && !dateSpecsMatch(schedulingWindow?.date, explicitWindow.date)) {
    verification.schedulingOverridden = true;
    schedulingWindow = { date: explicitWindow.date, time: schedulingWindow?.time ?? explicitWindow.time };
  }

  const verified: BarryIR = {
    ...ir,
    selectedOfferId,
    offerCandidateIds,
    constraints: { ...ir.constraints, schedulingWindow },
  };

  return { verified, verification };
}
