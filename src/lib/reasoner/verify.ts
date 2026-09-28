import { groundStructuredSearch, normalizeCurrency, type CatalogSchema } from "@/lib/commerce/catalog";
import type { BusinessGraph } from "@/lib/business-graph";
import { findOffer } from "@/lib/business-graph";
import type { ConversationState } from "@/lib/state";
import type { DateSpec, SchedulingConstraint, TimeSpec } from "@/lib/scheduling/resolver";
import type { BarryIR, CommerceSemantics } from "./ir";

/**
 * Grounding, not understanding.
 *
 *   customer text + model's BarryIR -> verifyIR() -> grounded BarryIR -> compiler
 *
 * The model owns semantics: what the customer means, what they refer to,
 * whether a phrase is a name. This layer never re-derives any of that
 * from the raw text and never INJECTS a value the model didn't propose —
 * the live bug that motivated this rewrite was a deterministic regex
 * turning "אני אקח את הראשונה" ("I'll take the first one") into
 * `name: "אקח"` over a model that had understood the message correctly.
 *
 * What it does instead:
 * - evidence: a customerInfo value is only accepted when the model cited
 *   a span of THIS message that is really there and really contains the
 *   value. Unsupported values are rejected, never replaced.
 * - state: a claim that only makes sense against existing state (slot
 *   confirmation, a reference into previous results) must match state.
 * - structure: values must be in range (weekday 0-6, hour 0-23, ...).
 * Every rejection is recorded so the Inspector can show exactly why.
 */
export type IRRejection = { claim: string; value?: unknown; reason: string };

export type IRVerification = {
  /** The reasoner's raw customerInfo proposal, before grounding. */
  llmCustomerInfo?: Record<string, string>;
  rejected: IRRejection[];
  /** Per proposed customer fact: what the model said, the quote it cited, and what grounding decided. */
  customerFacts?: CustomerFactCheck[];
};

export type CustomerFactCheck = {
  field: string;
  value: string;
  evidence: string | null;
  status: "accepted" | "rejected";
  reason?: string;
};

/**
 * A customer field name is a plain business field ("phone", "name",
 * "shoe_size"): lowercase letters, digits, underscores. Namespaced keys
 * ("customerInfo.phone") and BARRY's internal "__" state keys are never
 * customer fields — they are rejected, never rewritten.
 */
const CUSTOMER_FIELD = /^[a-z][a-z0-9_]{0,39}$/;

const OFFERED_SLOT_START_KEY = "__offeredSlotStart";
const SLOT_ACCEPTED_KEY = "__slotAccepted";

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s‏‎]+/g, " ").trim();
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Does `evidence` really occur in the message, and does it really contain `value`? */
export function evidenceSupports(message: string, evidence: string | undefined, value: string, field: string): boolean {
  if (!evidence || !evidence.trim()) return false;
  const text = normalizeText(message);
  const quote = normalizeText(evidence);
  if (!text.includes(quote)) return false;
  // Numeric values (phone numbers, ids) are compared by their digits, so
  // "055-883 2177" in the message supports "0558832177".
  if (field === "phone" || /^[\d\s()+\-./]+$/.test(value)) {
    const digits = digitsOnly(value);
    return digits.length > 0 && digitsOnly(quote).includes(digits);
  }
  return quote.includes(normalizeText(value));
}

function validDate(date: DateSpec | undefined): boolean {
  if (!date) return true;
  switch (date.kind) {
    case "weekday":
      return Number.isInteger(date.weekday) && date.weekday >= 0 && date.weekday <= 6;
    case "relativeDay":
      return Number.isInteger(date.days) && date.days >= 0 && date.days <= 366;
    case "explicitDate":
      return /^\d{4}-\d{2}-\d{2}$/.test(date.isoDate) && !Number.isNaN(Date.parse(`${date.isoDate}T00:00:00Z`));
  }
}

function validTime(time: TimeSpec | undefined): boolean {
  if (!time) return true;
  if (time.kind === "partOfDay") return true;
  return Number.isInteger(time.hour) && time.hour >= 0 && time.hour <= 23 && Number.isInteger(time.minute) && time.minute >= 0 && time.minute <= 59;
}

function groundScheduling(window: SchedulingConstraint | undefined, rejected: IRRejection[]): SchedulingConstraint | undefined {
  if (!window) return undefined;
  const date = validDate(window.date) ? window.date : undefined;
  const time = validTime(window.time) ? window.time : undefined;
  if (window.date && !date) rejected.push({ claim: "schedulingWindow.date", value: window.date, reason: "out of range" });
  if (window.time && !time) rejected.push({ claim: "schedulingWindow.time", value: window.time, reason: "out of range" });
  return date || time ? { date, time } : undefined;
}

function groundCommerce(
  commerce: CommerceSemantics | undefined,
  rejected: IRRejection[],
  catalog?: CatalogSchema,
  state?: ConversationState
): CommerceSemantics | undefined {
  if (!commerce) return undefined;
  const grounded: CommerceSemantics = { ...commerce, query: commerce.query ? { ...commerce.query } : undefined };
  if (grounded.reference) {
    // An explicit reference must point at something BARRY actually showed
    // or holds. Outside that set it is rejected AND marked, so the compiler
    // asks — it never falls back to guessing another item.
    const shownCount = state?.knownFields.__commerceLastProductIds?.split(",").filter(Boolean).length;
    const cartLines = state?.knownFields.__commerceCartLineId ? 1 : 0;
    const { type, index } = grounded.reference;
    const limit = type === "previous_result" ? shownCount : cartLines;
    const reason = !Number.isInteger(index) || index < 0 ? "invalid position" : limit !== undefined && index >= limit ? "points outside what BARRY showed" : undefined;
    if (reason) {
      rejected.push({ claim: "commerce.reference", value: grounded.reference, reason });
      grounded.reference = undefined;
      grounded.referenceInvalid = true;
    }
  }
  if (grounded.quantity !== undefined && (!Number.isInteger(grounded.quantity) || grounded.quantity < 1 || grounded.quantity > 50)) {
    rejected.push({ claim: "commerce.quantity", value: grounded.quantity, reason: "out of range" });
    grounded.quantity = undefined;
  }
  if (grounded.requestedPrice && !(grounded.requestedPrice.amount > 0)) {
    rejected.push({ claim: "commerce.requestedPrice", value: grounded.requestedPrice, reason: "not a positive amount" });
    grounded.requestedPrice = undefined;
  }
  if (grounded.variant) {
    const clean = Object.fromEntries(
      Object.entries(grounded.variant).filter(([k, v]) => typeof k === "string" && k.trim() && typeof v === "string" && v.trim())
    );
    grounded.variant = Object.keys(clean).length > 0 ? clean : undefined;
  }

  if (catalog) {
    // Structured fields must exist in THIS provider's catalog. Canonicalise
    // what does, move a variant-option key the model filed as an attribute,
    // reject the rest — the customer's words stay in queryText for ranking.
    const { search, rejected: catalogRejections } = groundStructuredSearch(catalog, {
      category: grounded.query?.category,
      attributes: grounded.query?.attributes,
      options: grounded.variant,
      budget: grounded.query?.budget,
    });
    for (const r of catalogRejections) {
      const claim = r.field.startsWith("options.") ? `commerce.variant.${r.field.slice(8)}` : `commerce.query.${r.field}`;
      rejected.push({ claim, value: r.value, reason: r.reason });
    }
    if (grounded.query) {
      grounded.query = { ...grounded.query, category: search.category, attributes: search.attributes, budget: search.budget };
    }
    grounded.variant = search.options;
  } else if (grounded.query?.budget) {
    const { budget } = grounded.query;
    const currency = budget.currency === undefined ? undefined : normalizeCurrency(budget.currency);
    if (!(budget.amount > 0) || (budget.currency !== undefined && !currency)) {
      rejected.push({ claim: "commerce.query.budget", value: budget, reason: !(budget.amount > 0) ? "not a positive amount" : "unrecognised currency" });
      grounded.query = { ...grounded.query, budget: undefined };
    } else {
      grounded.query = { ...grounded.query, budget: { amount: budget.amount, currency } };
    }
  }
  return grounded;
}

export function verifyIR(
  graph: BusinessGraph,
  customerMessage: string,
  ir: BarryIR,
  state?: ConversationState,
  context: { catalog?: CatalogSchema } = {}
): { verified: BarryIR; verification: IRVerification } {
  const rejected: IRRejection[] = [];

  // Customer facts persist, so each one must be backed by evidence the
  // model cited from THIS message. Nothing is ever added here.
  const customerInfo: Record<string, string> = {};
  const customerFacts: CustomerFactCheck[] = [];
  for (const [field, value] of Object.entries(ir.customerInfo)) {
    const evidence = ir.evidence?.[`customerInfo.${field}`];
    let reason: string | undefined;
    if (!CUSTOMER_FIELD.test(field)) {
      reason = field.startsWith("__") ? "internal state key — never a customer field" : "not a plain field name";
    } else if (!evidence) {
      reason = "no evidence cited";
    } else if (!evidenceSupports(customerMessage, evidence, value, field)) {
      reason = normalizeText(customerMessage).includes(normalizeText(evidence)) ? "evidence does not contain the value" : "evidence not found in this message";
    }
    customerFacts.push({ field, value, evidence: evidence ?? null, status: reason ? "rejected" : "accepted", ...(reason ? { reason } : {}) });
    if (reason) rejected.push({ claim: CUSTOMER_FIELD.test(field) ? `customerInfo.${field}` : `customerInfo[${JSON.stringify(field)}]`, value, reason });
    else customerInfo[field] = value;
  }

  const selectedOfferId = ir.selectedOfferId && findOffer(graph, ir.selectedOfferId) ? ir.selectedOfferId : undefined;
  if (ir.selectedOfferId && !selectedOfferId) rejected.push({ claim: "selectedOfferId", value: ir.selectedOfferId, reason: "unknown offer" });
  const offerCandidateIds = ir.offerCandidateIds?.filter((id) => findOffer(graph, id));
  const offerChangeRequested =
    ir.offerChangeRequested && findOffer(graph, ir.offerChangeRequested) ? ir.offerChangeRequested : undefined;

  // Accepting/declining a slot only means something while one is on offer.
  const awaitingConfirmation = Boolean(state?.knownFields[OFFERED_SLOT_START_KEY] && !state.knownFields[SLOT_ACCEPTED_KEY]);
  let { slotAccepted, slotDeclined } = ir.constraints;
  if ((slotAccepted || slotDeclined) && !awaitingConfirmation) {
    rejected.push({ claim: slotAccepted ? "slotAccepted" : "slotDeclined", reason: "no slot is awaiting confirmation" });
    slotAccepted = undefined;
    slotDeclined = undefined;
  }

  const verified: BarryIR = {
    ...ir,
    selectedOfferId,
    offerCandidateIds: offerCandidateIds && offerCandidateIds.length > 0 ? offerCandidateIds : undefined,
    offerChangeRequested,
    constraints: {
      ...ir.constraints,
      schedulingWindow: groundScheduling(ir.constraints.schedulingWindow, rejected),
      slotAccepted,
      slotDeclined,
    },
    commerce: groundCommerce(ir.commerce, rejected, context.catalog, state),
    customerInfo,
  };

  return { verified, verification: { llmCustomerInfo: ir.customerInfo, rejected, customerFacts } };
}
