import OpenAI from "openai";
import type { BusinessGraph } from "@/lib/business-graph";
import { findOffer } from "@/lib/business-graph";
import { LlmIRSchema, irJsonSchema, type CustomerFact, type LlmCommerce, type LlmIR, type LlmSchedulingWindow, type KeyValuePair } from "./schemas";
import { catalogForModel } from "@/lib/commerce/catalog";
import { profilesForModel } from "@/lib/capabilities/model";
import { createCompletion, isReasoningModel, modelFor, reasoningEffortFor, samplingParams, VALID_REASONING_EFFORTS } from "./model-config";
import { BARRY_CONSTITUTION } from "./constitution";
import type { CommerceSemantics } from "./ir";
import { composeDeterministic } from "./deterministic-compose";
import { logReasonerFailure } from "./diagnostics";
import type { BarryIR, ComposeResponseInput, Reasoner, ReasonerContext } from "./types";
import { sanitizeComposeInput } from "./compose-sanitization";
import type { SchedulingConstraint } from "@/lib/scheduling/resolver";
import type { CompileOutcome } from "@/lib/reasoner/ir";

/**
 * Strips everything from a CompileOutcome that the composer has no
 * legitimate reason to see before handing it to the LLM as JSON —
 * `.debug` (Inspector-only: `resolvedSchedulingWindow` is a raw UTC
 * ISO instant) and, for an "action" outcome, `action.input` (which for
 * checkAvailability/createBooking carries raw UTC `earliest`/`latest`
 * strings the model has no reason to read, since `scheduling`'s
 * localDate/localTime are already the one source of truth
 * for any date/time phrasing). No composer template anywhere reads
 * either of these — this closes the gap between "the prompt SAYS not
 * to use them" and "the raw data isn't even present to misuse," the
 * same never-trust-a-raw-timestamp principle the rest of this
 * architecture already applies everywhere else.
 */
export function sanitizeOutcomeForCompose(outcome: CompileOutcome): unknown {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to exclude it from `rest`
  const { debug, ...rest } = outcome;
  if (rest.kind === "action") {
    return { ...rest, action: { name: rest.action.name, input: {} } };
  }
  if (rest.kind === "ask_slot_confirm") {
    // offeredStart is also a raw UTC ISO instant — scheduling.offeredSlot
    // (localDate/localTime) is the one source of truth here.
    return { ...rest, offeredStart: "" };
  }
  return rest;
}

/**
 * LLM-backed Reasoner. It UNDERSTANDS free text into BARRY IR and nothing
 * more — it has no way to construct a tool call, because the schema it's
 * asked to fill in doesn't have an "action" or "input" field at all. The
 * deterministic Action Compiler (`src/lib/runtime/compiler.ts`) is the
 * only thing that ever assembles a ToolCall, and it validates that call
 * against the tool's own Zod schema before the runtime acts on it.
 *
 * This is the fix for a real failure observed in testing: the model once
 * proposed `checkAvailability` with only `{ offerId }`, missing the
 * required `earliest`. That bug class is now structurally impossible —
 * the model was never asked for tool input in the first place.
 */

/** What BARRY may decide alone vs. what goes to the owner — from the Genome's policies, never assumed. */
export function authorityForModel(graph: BusinessGraph) {
  const rule = <T extends string>(type: T) => graph.policies.find((p) => p.rule.type === type)?.rule as { value: number | boolean } | undefined;
  return {
    maxAutomaticDiscountPct: (rule("max_auto_discount_pct")?.value as number | undefined) ?? 0,
    maxAutomaticPaymentAmount: (rule("max_auto_payment_amount")?.value as number | undefined) ?? null,
    customPricingNeedsOwner: Boolean(rule("custom_pricing_requires_approval")?.value),
    refundsNeedOwner: rule("refund_requires_approval")?.value !== false,
    bookingsAutomatic: rule("bookings_auto_allowed")?.value !== false,
  };
}

/** The shown item BARRY is waiting on a variant choice for — by position and title, never by id. */
function pendingItem(ctx: ReasonerContext): { position: number; title: string } | null {
  const pending = ctx.state.knownFields.__commercePendingProductId;
  const item = pending ? ctx.grounded?.shownProducts?.find((p) => p.id === pending) : undefined;
  return item ? { position: item.position, title: item.title } : null;
}

export function buildUnderstandingContext(ctx: ReasonerContext) {
  const { graph, state } = ctx;
  const recentMessages = state.messages.slice(-8).map((m) => `${m.role}: ${m.content}`);

  const offers = graph.offers
    .filter((o) => o.active)
    .map((o) => ({
      id: o.id,
      name: o.name,
      description: o.description,
      kind: o.kind,
      price: o.price,
      currency: o.currency,
      requiresScheduling: o.requiresScheduling,
      durationMinutes: o.durationMinutes,
      requiresInventory: o.requiresInventory,
      requiresPayment: o.requiresPayment,
      depositAmount: o.depositAmount,
      requiredCustomerInfo: o.requiredCustomerInfo,
    }));

  // The model only ever needs to know today's date in the business's own
  // timezone to disambiguate an absolute calendar-date mention (e.g. "the
  // 5th" -> which month/year) — it never computes the final timestamp
  // itself; the Action Compiler's scheduling resolver does that.
  const currentDateInBusinessTimezone = new Intl.DateTimeFormat("en-CA", {
    timeZone: graph.business.timezone,
  }).format(new Date());

  // Customer-provided fields only — BARRY's internal "__" scratch state
  // is never shown to the model as if it were conversation content.
  const customerFields = Object.fromEntries(Object.entries(state.knownFields).filter(([key]) => !key.startsWith("__")));

  return {
    business: {
      name: graph.business.name,
      description: graph.business.description,
      tone: graph.business.tone,
      locale: graph.business.locale,
      timezone: graph.business.timezone,
      currentDate: currentDateInBusinessTimezone,
    },
    capabilities: graph.availableActions.filter((a) => a.enabled).map((a) => a.name),
    // What this business wants BARRY to achieve, and how it wants BARRY to operate.
    goals: graph.goals,
    playbook: {
      salesStyle: graph.playbook.salesStyle ?? null,
      advanceToCheckout: graph.playbook.commerce.advanceToCheckout,
      suggestions: graph.playbook.suggestions,
    },
    authority: authorityForModel(graph),
    // What the business's connected systems can actually do right now.
    connectedCapabilities: ctx.grounded?.profiles ? profilesForModel(ctx.grounded.profiles) : [],
    transaction: {
      cartOpen: Boolean(state.knownFields.__commerceCartId),
      checkoutSent: Boolean(state.knownFields.__paymentRequestId && !state.knownFields.__paid),
      paid: Boolean(state.knownFields.__paid),
      orderPlaced: Boolean(state.knownFields.__commerceOrderId),
    },
    offers,
    knowledgeTopics: graph.knowledge.map((k) => k.topic),
    knownCustomerFields: customerFields,
    // The exact customer fields BARRY's last reply asked for (the compiler's truth).
    askedFor: state.missingFields,
    previousMissingFields: state.missingFields,
    selectedOfferId: state.selectedOfferId ?? null,
    stage: state.stage,
    awaitingSlotConfirmation: Boolean(state.knownFields.__offeredSlotStart && !state.knownFields.__slotAccepted),
    openPaymentRequest: Boolean(state.knownFields.__paymentRequestId && !state.knownFields.__paid),
    // What this business's catalog can be searched by — map the customer's words onto these values.
    catalog: ctx.grounded?.catalog ? catalogForModel(ctx.grounded.catalog) : null,
    shownResults: ctx.grounded?.shownResults ?? [],
    // BARRY just asked which option the customer wants for this shown item.
    awaitingVariantChoiceFor: pendingItem(ctx),
    cart: ctx.grounded?.cart ?? [],
    cartTotal: ctx.grounded?.cartTotal ?? null,
    // The business's own systems' capabilities BARRY may propose (beyond the flows above), and what came back.
    capabilitySurface: ctx.grounded?.capabilities ?? [],
    capabilityResults: ctx.grounded?.capabilityResults ?? [],
    recentMessages,
  };
}

const UNDERSTAND_SYSTEM_PROMPT = `${BARRY_CONSTITUTION}

YOUR TASK NOW: understand the customer's latest message in context and describe it as structured IR. You are not replying and not acting — BARRY's runtime reads your IR and decides what to do under the business's rules. Every schema field is always present: null for "not applicable", [] for "none".

- intent: a short label for what the customer wants.
- commerce (null unless the business has commerce capabilities and the message is about products):
  - search: describe what they want, using the catalog's own vocabulary:
    - category: one of catalog.categories that fits, else null.
    - attributes: ONLY keys from catalog.attributes, with values copied exactly from that key's listed values (translate/normalise the customer's words, slang or typos onto them — e.g. a color word in any language -> the catalog's color value). If nothing listed fits, leave it out. Never put price, budget or size in attributes.
    - variant: requirements on catalog.variantOptions keys (e.g. a size), values copied exactly from the listed values.
    - budgetAmount + budgetCurrency: a stated maximum price. budgetCurrency is an ISO 4217 code (the customer's shekel/₪/NIS is "ILS"); null when they named no currency.
    - queryText: the customer's own descriptive words, for ranking only.
  - select: the customer chooses an item BARRY showed — including when they decide to buy it right away ("I'll take it", "give me that one in M"). Record the decision in purchaseDecision, not as checkout.
  - inquire: a question about a shown item ("do you have it in M?", "how much is the second?"). BARRY answers from live stock; it is not a choice.
  - replace: the cart already has an item and they want a DIFFERENT shown item instead.
  - change_variant / change_quantity / remove: they change what is already in the cart (referenceType "cart_line").
  - checkout: the cart already has items (transaction.cartOpen) and they want to pay / finish.
  - negotiate_price: they ask for a different price (requestedPriceAmount).
  REFERENCES — which item they mean:
  - referenceType "previous_result" + referencePosition = the item's "position" in shownResults (1 = first, as numbered to the customer; "the last one" = the highest position), when their words identify it (ordinal, name, description).
  - If they just say "it" / "that one" / "אותה" / "זה" without saying which, set referenceType and referencePosition to null. BARRY resolves it only when exactly one item could be meant, and asks otherwise — so never guess a position.
  - If awaitingVariantChoiceFor is set and they only name an option ("M"), that answers BARRY's question: select, no reference, the option in variant.
  - Options they ask for (size, color, ...) go in variant, as catalog values.
  EXAMPLES (shownResults with 1 item): "אני אקח אותה במדיום" -> select, reference null, variant {size: M}, purchaseDecision true. "יש אותה ב-L?" -> inquire, reference null, variant {size: L}, purchaseDecision false.
  EXAMPLES (shownResults with 3 items): "אני אקח את השנייה" -> select, previous_result position 2, purchaseDecision true. "עזוב, תביא את האחרונה" -> select, position 3. "אני אקח אותה" with nothing singling one out -> select, reference null (BARRY will ask). "תוסיף אותה לעגלה אבל אני עוד מסתכלת" -> select, purchaseDecision false. "היא יפה" -> commerce null.
- customerFacts: details the customer states about THEMSELVES in this message. One item per detail: { field, value, evidence }.
  - field: a plain lowercase field name. When they are answering BARRY's question, use the names in askedFor exactly (e.g. "name", "phone"); otherwise a clear name ("email", "address").
  - value: the detail as they gave it. evidence: the exact text from THIS message that contains it (for a message that is only the detail, the whole message).
  - A verb, a product, a relationship word ("my wife") or anything that isn't their own detail is never a fact. Omit anything not given this turn — never placeholders.
- customerClaimsPaymentCompleted: true when the customer says they paid. It is only a claim; BARRY verifies it with the provider.
- purchaseDecision: true when the customer has DECIDED to buy what's being discussed ("I'll take it", "yalla, I'm taking it"); false when they are asking, admiring, comparing, or adding while still browsing; null if unclear. It is consent for BARRY to move the purchase forward per the business playbook — never a payment or an order.
- knowledgeTopic: when they ask about something covered by one of knowledgeTopics, that exact topic string.
- capabilityRequest: when the customer's need is served by one of capabilitySurface's capabilities (and not by the offers/commerce flows above), propose it: the exact capability id, inputJson = a JSON object of its inputs using ONLY values the customer said or that appear in knownCustomerFields/capabilityResults (never invent an id, number or address; for an input that lists options, use exactly one of those options; leave the request null and let BARRY ask if a required input is unknown), and a one-line purpose. Only propose capabilities marked available; one whose authority is not_permitted can't be used for this business, so don't propose it. You never decide whether it is allowed — BARRY does. If capabilityResults already answer the need, don't request it again; propose the NEXT capability only if the result makes it necessary for what the customer wants (e.g. the result shows a problem that another capability on the surface exists to handle); otherwise null.
- Scheduling: describe what they said, never compute timestamps. schedulingWindow fields: dateKind (explicitDate|relativeDay|weekday), isoDate (YYYY-MM-DD, resolve using business.currentDate), relativeDays, weekday (0=Sun..6=Sat), weekdayQualifier (this|next), timeKind (explicitTime|partOfDay), hour/minute (24h, as the customer meant it locally), partOfDay. Keep a day/time stated earlier unless they changed it.
- slotAccepted / slotDeclined: only when awaitingSlotConfirmation is true and they accept or decline the offered time.
- selectedOfferId / offerCandidateIds: for services in "offers"; several plausible -> candidates. offerChangeRequested only for an explicit change of mind to a different real offer.
- requestedCapability: "ask_price" | "ask_duration" | "ask_deposit" when they ask that about an offer; else null.
- Output strict JSON only.`;

/**
 * Live bug fixed by this prompt: after checkAvailability had ALREADY
 * returned slots, BARRY told the customer "I'll check availability and
 * get back to you shortly" — a future-tense claim about something that
 * had already happened, because the model was free to phrase the JSON
 * summary however it liked. `toolSucceeded`/`toolOutput` being present
 * means the action is DONE; the model only ever describes the result.
 */
export const COMPOSE_SYSTEM_PROMPT =
  `${BARRY_CONSTITUTION}\n\nYOUR TASK NOW: write BARRY's reply to the customer. ` +
  "Use the business's tone. Reply in the language given by `replyLanguage` (mirror the language of replyLanguage.basedOn when present; code is a hint). " +
  "A customer message that is only a phone number, email, code, link or emoji never changes the language. " +
  "The JSON summary below is the ONLY source of truth for what happened — " +
  "describe exactly that, never inventing a price, availability, or outcome beyond it. " +
  "If policyReason is set, explain briefly and warmly that you're checking with the owner. " +
  "If toolSucceeded is true or false, the action has ALREADY RUN — describe its result " +
  "(toolOutput on success, a brief apology and alternative on failure). NEVER say you will " +
  "check, look up, confirm, or get back to them later for something toolOutput/toolError " +
  "already answers — phrases like \"I'll check\" or \"I'll get back to you shortly\" are " +
  "forbidden whenever a tool already ran this turn. " +
  "If `scheduling` is present, any date/time you mention MUST use its localDate string " +
  "verbatim plus its localTime string verbatim. That localTime value has already been " +
  "formatted for the reply language (24-hour for Hebrew, 12-hour for English). Never " +
  "choose another time format, and never compute, convert, or reinterpret a time yourself from any raw ISO " +
  "timestamp elsewhere in this JSON (that is always UTC, not the customer's local time). " +
  "When outcome.kind (or next.kind) is \"needs_info\" or \"checkout_needs_info\", ask for EXACTLY the fields listed in " +
  "outcome.missingFields — one per field (\"your name\", \"your phone number\"), never more, " +
  "never pluralized or duplicated because of partySize or any other constraint. Only ask " +
  "for a field the Business Graph actually lists as missing; never invent an additional " +
  "requirement (e.g. \"names and phone numbers\" when missingFields is just [\"name\", " +
  "\"phone\"]) — BARRY collects ONE customer's contact info per booking unless the Business " +
  "Graph's own required fields say otherwise. " +
  "If `steps` is present, BARRY took several actions this turn and ALL of them already happened: " +
  "say briefly where things now stand (the end result, not a log of each step), then ask for the ONE thing in `next` if present. " +
  "When an action is \"invokeCapability\", toolOutput.output is what the business's own system returned: answer the customer from exactly those facts (translate field names naturally). If toolOutput.verified is false for something that changes the world, or toolOutput.ok is false, never say it was done. " +
  "When outcome.kind is \"capability_needs_input\", ask for exactly the listed fields, nothing else. " +
  "When outcome.kind is \"checkout_needs_info\", the customer has decided to buy: ask only for those details so BARRY can send the payment link — never ask whether they want to continue. " +
  "Follow `playbook.salesStyle` when present; mention at most one genuinely relevant suggestion and only if playbook.suggestions is \"one_relevant\". " +
  "Keep it to 1-3 sentences, no headers, no JSON.";

function factsToCustomerInfo(facts: CustomerFact[]): { customerInfo: Record<string, string>; evidence: Record<string, string> } {
  const customerInfo: Record<string, string> = {};
  const evidence: Record<string, string> = {};
  for (const fact of facts) {
    const field = fact.field.trim();
    if (!field) continue;
    customerInfo[field] = fact.value;
    evidence[`customerInfo.${field}`] = fact.evidence;
  }
  return { customerInfo, evidence };
}

function kvArrayToRecord(pairs: KeyValuePair[]): Record<string, string> {
  return Object.fromEntries(pairs.map((p) => [p.key, p.value]));
}

/** Reconstruct the real DateSpec|TimeSpec union from the flattened, strict-mode-compatible wire shape. */
function unflattenSchedulingWindow(raw: LlmSchedulingWindow | null): SchedulingConstraint | undefined {
  if (!raw || (!raw.dateKind && !raw.timeKind)) return undefined;

  let date: SchedulingConstraint["date"];
  if (raw.dateKind === "explicitDate" && raw.isoDate) {
    date = { kind: "explicitDate", isoDate: raw.isoDate };
  } else if (raw.dateKind === "relativeDay" && raw.relativeDays !== null) {
    date = { kind: "relativeDay", days: raw.relativeDays };
  } else if (raw.dateKind === "weekday" && raw.weekday !== null) {
    date = { kind: "weekday", weekday: raw.weekday, qualifier: raw.weekdayQualifier ?? undefined };
  }

  let time: SchedulingConstraint["time"];
  if (raw.timeKind === "explicitTime" && raw.hour !== null && raw.minute !== null) {
    time = { kind: "explicitTime", hour: raw.hour, minute: raw.minute };
  } else if (raw.timeKind === "partOfDay" && raw.partOfDay) {
    time = { kind: "partOfDay", part: raw.partOfDay };
  }

  if (!date && !time) return undefined;
  return { date, time };
}

/** Never trust the model's offer id/candidates without checking they exist on this business. */
export function sanitizeIR(graph: BusinessGraph, raw: LlmIR): BarryIR {
  const selectedOfferId =
    raw.selectedOfferId && findOffer(graph, raw.selectedOfferId) ? raw.selectedOfferId : undefined;

  const offerCandidateIds = raw.offerCandidateIds.filter((id) => findOffer(graph, id));
  const offerChangeRequested =
    raw.offerChangeRequested && findOffer(graph, raw.offerChangeRequested) ? raw.offerChangeRequested : undefined;

  return {
    intent: raw.intent,
    selectedOfferId,
    offerCandidateIds: offerCandidateIds.length > 0 ? offerCandidateIds : undefined,
    offerChangeRequested,
    entities: kvArrayToRecord(raw.entities),
    constraints: {
      schedulingWindow: unflattenSchedulingWindow(raw.constraints.schedulingWindow),
      partySize: raw.constraints.partySize ?? undefined,
      discountPct: raw.constraints.discountPct ?? undefined,
      slotAccepted: raw.constraints.slotAccepted ?? undefined,
      slotDeclined: raw.constraints.slotDeclined ?? undefined,
    },
    // One fact = field + value + its own quote. Mapped into BARRY's internal
    // shape unchanged; field NAMES are validated by grounding (verifyIR),
    // which rejects — never rewrites — anything that isn't a plain field.
    ...factsToCustomerInfo(raw.customerFacts),
    requestedCapability: raw.requestedCapability ?? undefined,
    goal: raw.goal ?? undefined,
    commerce: raw.commerce ? unflattenCommerce(raw.commerce) : undefined,
    customerClaims: raw.customerClaimsPaymentCompleted ? { paymentCompleted: true } : undefined,
    purchaseDecision: raw.purchaseDecision ?? undefined,
    knowledgeTopic: raw.knowledgeTopic ?? undefined,
    capabilityRequest: parseCapabilityRequest(raw.capabilityRequest),
  };
}

/** The model's capability proposal, parsed as untrusted data: a JSON OBJECT of inputs, bounded, or nothing. */
function parseCapabilityRequest(raw: LlmIR["capabilityRequest"]): BarryIR["capabilityRequest"] {
  if (!raw || !raw.capability) return undefined;
  let input: unknown;
  try {
    input = raw.inputJson.trim() ? JSON.parse(raw.inputJson) : {};
  } catch {
    return undefined;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return { capability: raw.capability, input: input as Record<string, unknown>, purpose: raw.purpose };
}

function nonEmptyRecord(pairs: KeyValuePair[]): Record<string, string> | undefined {
  const record = kvArrayToRecord(pairs.filter((p) => p.key.trim() && p.value.trim()));
  return Object.keys(record).length > 0 ? record : undefined;
}

/** Reconstruct commerce semantics from the flattened wire shape. Ids never come from the model — only positions. */
function unflattenCommerce(raw: LlmCommerce): CommerceSemantics {
  return {
    intent: raw.intent,
    query:
      raw.queryText || raw.category || raw.attributes.length || raw.budgetAmount
        ? {
            text: raw.queryText ?? undefined,
            category: raw.category ?? undefined,
            attributes: nonEmptyRecord(raw.attributes),
            budget: raw.budgetAmount ? { amount: raw.budgetAmount, currency: raw.budgetCurrency ?? undefined } : undefined,
          }
        : undefined,
    reference:
      // The model speaks in the positions the customer saw (1-based); BARRY's
      // IR is 0-based. A non-integer or < 1 position becomes an invalid index
      // that grounding rejects — it is never repaired.
      raw.referenceType && raw.referencePosition !== null ? { type: raw.referenceType, index: raw.referencePosition - 1 } : undefined,
    variant: nonEmptyRecord(raw.variant),
    quantity: raw.quantity ?? undefined,
    requestedPrice: raw.requestedPriceAmount ? { amount: raw.requestedPriceAmount, currency: raw.requestedPriceCurrency ?? undefined } : undefined,
  };
}

/**
 * Compose output is plain text; product cards and links travel in the
 * channel's rich payload. Strip markdown the model may still produce so
 * no "**[Title](url)**" / "![alt](img)" ever reaches a customer.
 */
export function toPlainText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type ParseIRResult = { ok: true; ir: BarryIR } | { ok: false; kind: "json_parse_error" | "schema_validation_error"; detail: string };

export type ComposeSummaryContext = {
  businessTone: unknown;
  lastCustomerMessage: string;
  responseStatus?: ComposeResponseStatus;
  /** The business's own operating playbook (sales style, suggestions) — overrides general habits. */
  playbook?: { salesStyle: string | null; suggestions: string };
};

type ComposeResponseStatus =
  | "booking_confirmed"
  | "availability_checked"
  | "booking_failed"
  | "tool_failed"
  | "other";

const BOOKING_SUCCESS_LANGUAGE =
  /\b(successfully\s+booked|booked|reserved|reservation\s+confirmed|booking\s+confirmed|confirmed\s+(?:your\s+)?appointment|appointment\s+(?:is\s+)?confirmed)\b/i;
const PAYMENT_SUCCESS_LANGUAGE =
  /\b(successfully\s+paid|payment\s+(?:is\s+)?(?:complete|completed|received|successful|verified)|paid\s+(?:successfully|confirmed))\b/i;
const INVENTED_CUSTOMER_INFO_REQUEST =
  /\b(phone|phone\s+number|email|email\s+address|name|full\s+name)\b|טלפון|אימייל|מייל|שם/i;

function composeResponseStatus(ctx: ReasonerContext, input: ComposeResponseInput): ComposeResponseStatus {
  const { outcome, toolResult } = input;
  if (outcome.kind !== "action") return "other";
  if (outcome.action.name === "createBooking") {
    if (toolResult?.ok && ctx.state.stage === "closed" && ctx.state.outcome === "won") return "booking_confirmed";
    return toolResult?.ok ? "other" : "booking_failed";
  }
  if (outcome.action.name === "checkAvailability" && toolResult?.ok) return "availability_checked";
  if (toolResult && !toolResult.ok) return "tool_failed";
  return "other";
}

export function enforceComposeGrounding(text: string, ctx: ReasonerContext, input: ComposeResponseInput): string {
  const status = composeResponseStatus(ctx, input);
  if (status !== "booking_confirmed" && BOOKING_SUCCESS_LANGUAGE.test(text)) {
    return composeDeterministic(input);
  }
  if (ctx.state.knownFields.__paid !== "1" && PAYMENT_SUCCESS_LANGUAGE.test(text)) {
    return composeDeterministic(input);
  }
  if (
    status === "availability_checked" &&
    ctx.state.missingFields.length === 0 &&
    INVENTED_CUSTOMER_INFO_REQUEST.test(text)
  ) {
    return composeDeterministic(input);
  }
  return text;
}

export function buildComposeSummary(context: ComposeSummaryContext, input: ComposeResponseInput) {
  const sanitizedInput = sanitizeComposeInput(input);
  return {
    businessTone: context.businessTone,
    lastCustomerMessage: context.lastCustomerMessage,
    outcome: sanitizeOutcomeForCompose(sanitizedInput.outcome),
    policyReason: sanitizedInput.policyReason ?? null,
    toolSucceeded: sanitizedInput.toolResult?.ok ?? null,
    toolOutput: sanitizedInput.toolResult?.ok ? sanitizedInput.toolResult.output : undefined,
    toolError: sanitizedInput.toolResult && !sanitizedInput.toolResult.ok ? sanitizedInput.toolResult.error : undefined,
    responseStatus: context.responseStatus ?? "other",
    // Pre-computed, business-timezone-local display facts for any
    // scheduling instant this turn — the ONLY source of truth for
    // "what time is that for the customer." Never present when there's
    // nothing scheduling-related to phrase.
    scheduling: sanitizedInput.scheduling ?? null,
    playbook: context.playbook ?? null,
    // The conversation's language, resolved by BARRY from the latest customer
    // message that contains words — never from a number/email/code/emoji.
    replyLanguage: sanitizedInput.language ? { code: sanitizedInput.language.code, basedOn: sanitizedInput.language.sample ?? null } : null,
    // Everything BARRY already did this turn, in order — all of it has happened.
    steps: sanitizedInput.steps
      ? sanitizedInput.steps.map((st) => ({
          outcome: sanitizeOutcomeForCompose(st.outcome),
          succeeded: st.toolResult ? st.toolResult.ok : null,
          output: st.toolResult?.ok ? st.toolResult.output : undefined,
          error: st.toolResult && !st.toolResult.ok ? st.toolResult.error : undefined,
          waitingForOwner: st.policyReason ?? undefined,
        }))
      : null,
    // The single thing still needed from the customer, if any.
    next: sanitizedInput.next ? sanitizeOutcomeForCompose(sanitizedInput.next) : null,
  };
}

/**
 * Pure parse+validate+sanitize pipeline for a raw completion string, with
 * no network I/O — this is what makes the failure modes unit-testable
 * without mocking the OpenAI client. `understand()` below is a thin
 * network wrapper around this.
 */
export function parseIRResponse(graph: BusinessGraph, raw: string): ParseIRResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, kind: "json_parse_error", detail: raw.slice(0, 200) };
  }

  const parsed = LlmIRSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      kind: "schema_validation_error",
      detail: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`).join("; "),
    };
  }

  return { ok: true, ir: sanitizeIR(graph, parsed.data) };
}

export type UnderstandingResult = {
  ir: BarryIR;
  /** Whether the model produced schema-valid structured output (after at most one retry). */
  valid: boolean;
  attempts: number;
  failure?: string;
  latencyMs: number;
  usage: { promptTokens: number; completionTokens: number; reasoningTokens: number };
  model: string;
};

function emptyIR(intent: string): BarryIR {
  return { intent, entities: {}, constraints: {}, customerInfo: {} };
}

export class OpenAIReasoner implements Reasoner {
  readonly name = "llm" as const;
  private client: OpenAI;
  /** The understanding model (recorded in every turn trace). */
  readonly model: string;
  readonly composerModel: string;
  /** Effort sent with each call (reasoning models only; undefined = provider default / not applicable). */
  readonly reasoningEffort?: string;
  readonly composerReasoningEffort?: string;
  /**
   * An invalid model configuration is not guessed around: understanding
   * fails closed (no action can be compiled from it) and replies fall back
   * to the deterministic composer, with the error in every turn trace.
   */
  readonly configError?: string;

  constructor(options: { model?: string; composerModel?: string; reasoningEffort?: string } = {}) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set — cannot construct OpenAIReasoner.");
    this.client = new OpenAI({ apiKey });
    this.model = options.model ?? modelFor("reasoner");
    this.composerModel = options.composerModel ?? options.model ?? modelFor("composer");
    try {
      if (options.reasoningEffort !== undefined && !VALID_REASONING_EFFORTS.has(options.reasoningEffort)) {
        throw new Error(`Invalid reasoning effort "${options.reasoningEffort}" for reasoner`);
      }
      const reasonerEffort = options.reasoningEffort ?? reasoningEffortFor("reasoner");
      const composerEffort = reasoningEffortFor("composer");
      this.reasoningEffort = isReasoningModel(this.model) ? reasonerEffort : undefined;
      this.composerReasoningEffort = isReasoningModel(this.composerModel) ? composerEffort : undefined;
    } catch (err) {
      this.configError = err instanceof Error ? err.message : String(err);
      logReasonerFailure("openai_api_error", { message: `model configuration: ${this.configError}` });
    }
  }

  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    return (await this.understandDetailed(ctx)).ir;
  }

  /**
   * understand() plus telemetry, for traces and model evaluation:
   * whether structured output was valid, attempts used, latency and tokens.
   */
  async understandDetailed(ctx: ReasonerContext): Promise<UnderstandingResult> {
    const context = buildUnderstandingContext(ctx);
    const started = Date.now();
    const usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
    let lastFailure: string | undefined;

    if (this.configError) {
      return { ir: emptyIR("understanding_failed"), valid: false, attempts: 0, failure: "invalid_model_config", latencyMs: 0, usage, model: this.model };
    }

    const attempt = async (correction?: string): Promise<BarryIR | null> => {
      let raw: string | null | undefined;
      try {
        const completion = await createCompletion(this.client, {
          model: this.model,
          messages: [
            { role: "system", content: UNDERSTAND_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(context) },
            ...(correction ? [{ role: "system" as const, content: correction }] : []),
          ],
          response_format: { type: "json_schema", json_schema: irJsonSchema() },
          ...samplingParams(this.model, "reasoner", 0.2, this.reasoningEffort),
        });
        usage.promptTokens += completion.usage?.prompt_tokens ?? 0;
        usage.completionTokens += completion.usage?.completion_tokens ?? 0;
        usage.reasoningTokens += completion.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
        raw = completion.choices[0]?.message?.content;
      } catch (err) {
        lastFailure = "openai_api_error";
        logReasonerFailure("openai_api_error", { message: err instanceof Error ? err.message : String(err) });
        return null;
      }

      if (!raw) {
        lastFailure = "empty_completion";
        logReasonerFailure("openai_api_error", { message: "empty completion content" });
        return null;
      }

      const result = parseIRResponse(ctx.graph, raw);
      if (!result.ok) {
        lastFailure = result.kind;
        logReasonerFailure(result.kind, { detail: result.detail });
        return null;
      }
      return result.ir;
    };

    const first = await attempt();
    if (first) return { ir: first, valid: true, attempts: 1, latencyMs: Date.now() - started, usage, model: this.model };

    const retried = await attempt(
      "Your previous response was invalid. Respond again with ONLY strict JSON matching the schema."
    );
    if (retried) return { ir: retried, valid: true, attempts: 2, latencyMs: Date.now() - started, usage, model: this.model };

    logReasonerFailure("semantic_validation_error", {
      message: "both understanding attempts failed; falling back to empty IR",
    });
    return { ir: emptyIR("understanding_failed"), valid: false, attempts: 2, failure: lastFailure, latencyMs: Date.now() - started, usage, model: this.model };
  }

  async composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    if (this.configError) return composeDeterministic(input);
    const lastCustomerMessage = ctx.state.messages.filter((m) => m.role === "customer").at(-1)?.content ?? "";

    const summary = buildComposeSummary(
      {
        businessTone: ctx.graph.business.tone,
        lastCustomerMessage,
        responseStatus: composeResponseStatus(ctx, input),
        playbook: { salesStyle: ctx.graph.playbook.salesStyle ?? null, suggestions: ctx.graph.playbook.suggestions },
      },
      input
    );

    try {
      const completion = await createCompletion(this.client, {
        model: this.composerModel,
        messages: [
          { role: "system", content: COMPOSE_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(summary) },
        ],
        ...samplingParams(this.composerModel, "composer", 0.4, this.composerReasoningEffort),
      });
      const text = completion.choices[0]?.message?.content?.trim();
      if (text) return enforceComposeGrounding(toPlainText(text), ctx, input);
      logReasonerFailure("openai_api_error", { message: "empty completion content during composeResponse" });
    } catch (err) {
      logReasonerFailure("openai_api_error", {
        message: err instanceof Error ? err.message : String(err),
        during: "composeResponse",
      });
    }

    return composeDeterministic(input);
  }
}
