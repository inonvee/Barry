import type { BusinessGraph } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";
import type { DateSpec, SchedulingConstraint, TimeSpec } from "@/lib/scheduling/resolver";
import {
  findOffersByExplicitNameReference,
  extractExplicitSchedulingConstraint,
  extractAnnouncedName,
  extractExplicitPhone,
  extractExplicitEmail,
  hasThirdPartyNameEvidence,
  isInvalidCustomerNameCandidate,
} from "./entities";
import type { BarryIR } from "./ir";

const OFFERED_SLOT_START_KEY = "__offeredSlotStart";
const SLOT_ACCEPTED_KEY = "__slotAccepted";

const AFFIRMATIVE_SHORT_REPLIES = new Set([
  "yes",
  "yeah",
  "yep",
  "sure",
  "confirm",
  "confirmed",
  "כן",
  "מאשר",
  "סבבה",
  "מתאים",
  "יאללה",
]);

const DECLINE_SHORT_REPLIES = new Set(["no", "nope", "לא", "לא מתאים"]);

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
  llmCustomerInfo?: Record<string, string>;
  offerOverridden: boolean;
  schedulingOverridden: boolean;
  customerInfoOverridden: boolean;
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

function timesMatch(a: TimeSpec | undefined, b: TimeSpec): boolean {
  if (!a || a.kind !== b.kind) return false;
  switch (b.kind) {
    case "explicitTime":
      return a.kind === "explicitTime" && a.hour === b.hour && a.minute === b.minute;
    case "partOfDay":
      return a.kind === "partOfDay" && a.part === b.part;
  }
}

function normalizeShortReply(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[\s"'`.,!?;:()]+|[\s"'`.,!?;:()]+$/g, "")
    .replace(/\s+/g, " ");
}

function awaitingSlotConfirmation(state: ConversationState | undefined): boolean {
  return Boolean(state?.knownFields[OFFERED_SLOT_START_KEY] && !state.knownFields[SLOT_ACCEPTED_KEY]);
}

export function verifyIR(
  graph: BusinessGraph,
  customerMessage: string,
  ir: BarryIR,
  state?: ConversationState
): { verified: BarryIR; verification: IRVerification } {
  const verification: IRVerification = {
    llmSelectedOfferId: ir.selectedOfferId,
    llmOfferCandidateIds: ir.offerCandidateIds,
    llmSchedulingWindow: ir.constraints.schedulingWindow,
    llmCustomerInfo: ir.customerInfo,
    offerOverridden: false,
    schedulingOverridden: false,
    customerInfoOverridden: false,
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
  if (explicitWindow?.time && !timesMatch(schedulingWindow?.time, explicitWindow.time)) {
    verification.schedulingOverridden = true;
    schedulingWindow = { ...schedulingWindow, time: explicitWindow.time };
  }

  // --- Customer identity verification ---
  // The live bug this guards against: a Reasoner (LLM) correctly
  // understood "My name is Inon and my phone number is 057484848" (it
  // showed up in `entities`) but never populated `customerInfo` — the
  // ONLY field the compiler actually merges into persistent state — so
  // BARRY kept asking for name/phone it had already been given. Rather
  // than trust the Reasoner to always remember to fill customerInfo,
  // BARRY independently extracts the same small set of high-confidence,
  // structurally unambiguous identity signals from the raw text — an
  // explicit self-announcement ("my name is X", "call me X"), an
  // explicit phone number, an explicit email address — and injects them
  // whenever they're absent or disagree with what the Reasoner reported.
  // Fuzzy/contextual identity inference (a bare "Inon" replying to "what's
  // your name?") is NOT extracted here — that's still the Reasoner's job;
  // this only acts on text that is unambiguous on its own.
  let customerInfo = ir.customerInfo;

  const explicitName = extractAnnouncedName(customerMessage);
  if (explicitName && customerInfo.name !== explicitName) {
    customerInfo = { ...customerInfo, name: explicitName };
    verification.customerInfoOverridden = true;
  } else if (!explicitName && customerInfo.name && (isInvalidCustomerNameCandidate(customerInfo.name) || hasThirdPartyNameEvidence(customerMessage))) {
    const rest = { ...customerInfo };
    delete rest.name;
    customerInfo = rest;
    verification.customerInfoOverridden = true;
  }

  const explicitPhone = extractExplicitPhone(customerMessage);
  if (explicitPhone && customerInfo.phone !== explicitPhone) {
    customerInfo = { ...customerInfo, phone: explicitPhone };
    verification.customerInfoOverridden = true;
  }

  const explicitEmail = extractExplicitEmail(customerMessage);
  if (explicitEmail && customerInfo.email !== explicitEmail) {
    customerInfo = { ...customerInfo, email: explicitEmail };
    verification.customerInfoOverridden = true;
  }

  let slotAccepted = ir.constraints.slotAccepted;
  let slotDeclined = ir.constraints.slotDeclined;
  if (awaitingSlotConfirmation(state)) {
    const shortReply = normalizeShortReply(customerMessage);
    if (AFFIRMATIVE_SHORT_REPLIES.has(shortReply)) {
      slotAccepted = true;
      slotDeclined = undefined;
      if (!ir.constraints.slotAccepted) verification.schedulingOverridden = true;
    } else if (DECLINE_SHORT_REPLIES.has(shortReply)) {
      slotDeclined = true;
      slotAccepted = undefined;
      if (!ir.constraints.slotDeclined) verification.schedulingOverridden = true;
    }
  }

  const verified: BarryIR = {
    ...ir,
    selectedOfferId,
    offerCandidateIds,
    constraints: { ...ir.constraints, schedulingWindow, slotAccepted, slotDeclined },
    customerInfo,
  };

  return { verified, verification };
}
