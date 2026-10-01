import OpenAI from "openai";
import type { BusinessGraph } from "@/lib/business-graph";
import { findOffer } from "@/lib/business-graph";
import { discountPolicyOf, discountWords } from "@/lib/policy/effective-rules";
import { LlmIRSchema, irJsonSchema, type CustomerFact, type LlmCommerce, type LlmIR, type LlmSchedulingWindow, type KeyValuePair } from "./schemas";
import { catalogForModel } from "@/lib/commerce/catalog";
import { profilesForModel } from "@/lib/capabilities/model";
import { createCompletion, isReasoningModel, modelFor, reasoningEffortFor, samplingParams, VALID_REASONING_EFFORTS } from "./model-config";
import { BARRY_CONSTITUTION } from "./constitution";
import type { CommerceSemantics } from "./ir";
import { composeDeterministic } from "./deterministic-compose";
import { logReasonerFailure } from "./diagnostics";
import type { AskOutcome, BarryIR, ComposeResponseInput, ModelCallFailure, PolicyContradiction, Reasoner, ReasonerContext, UnderstandingResult } from "./types";
export type { UnderstandingResult } from "./types";
import { sanitizeComposeInput } from "./compose-sanitization";
import { businessFacts, customerFacts, transactionFacts } from "./compose-facts";
import { customerReceipts } from "./receipts";
import { effectPhrase, ledgerView } from "@/lib/runtime/ledger";
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
  // The EFFECTIVE rule (the same overlay the policy engine enforces), with where it came from — so the
  // model can explain behaviour. It never enforces it: decide() does.
  const discount = discountPolicyOf(graph);
  return {
    maxAutomaticDiscountPct: (rule("max_auto_discount_pct")?.value as number | undefined) ?? 0,
    ...(discount ? { discountRule: { words: discountWords(discount.value), source: discount.provenance.source === "owner_trained" ? "taught by the owner" : "business profile", enforcedBy: "BARRY's policy engine — above the limit the owner approves the exact terms" } } : {}),
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

/** How much of the conversation the model re-reads each turn: enough for references and corrections across long chats. */
const UNDERSTANDING_HISTORY = 16;
/** How much of the conversation the composer sees, to keep continuity, pacing and the customer's register. */
const COMPOSE_HISTORY = 16;

export function buildUnderstandingContext(ctx: ReasonerContext) {
  const { graph, state } = ctx;
  const recentMessages = state.messages.slice(-UNDERSTANDING_HISTORY).map((m) => `${m.role}: ${m.content}`);

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
    // BARRY already asked the owner about something in this conversation and is waiting for the answer.
    awaitingOwnerApproval: Boolean(state.pendingApprovalId),
    // Every request sent to the owner in this conversation (what, status, outcome) — for status
    // questions, withdrawals and changed terms (see withdrawsRequest / changesPendingRequest).
    pendingOwnerRequests: (ctx.grounded?.ownerRequests ?? []).filter((r) => r.status === "waiting_on_owner"),
    ownerRequests: ctx.grounded?.ownerRequests ?? [],
    // Set when this message asked for several changes and some were already carried out THIS turn:
    // describe the next one from remainingAsks (see asks).
    alreadyDoneThisTurn: ctx.grounded?.doneThisTurn ?? [],
    remainingAsks: ctx.grounded?.remainingAsks ?? [],
    // Set when the customer just changed a pending request's terms: these requests are being replaced.
    replacingRequests: ctx.grounded?.replacingRequests ?? [],
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
  - subjectTitle: when they NAME the item an action applies to — a change ("remove the Midnight", "make the black one an L") OR an addition ("add two Onyx in M", "I'll take the Slim Belt") — that item's name exactly as it appears in cart[].title or shownResults[].title; if what they named isn't there, their own words for it (the name only; size/colour go in variant). null when they didn't name it. A named item is never the one currently under discussion just because it is nearby. keepTitles: items they explicitly say to keep/leave as they are in this message ("keep the Onyx"), by name. Never swap the two.
  EXAMPLES (shownResults with 1 item): "אני אקח אותה במדיום" -> select, reference null, variant {size: M}, purchaseDecision true. "יש אותה ב-L?" -> inquire, reference null, variant {size: L}, purchaseDecision false.
  EXAMPLES (shownResults with 3 items): "אני אקח את השנייה" -> select, previous_result position 2, purchaseDecision true. "עזוב, תביא את האחרונה" -> select, position 3. "אני אקח אותה" with nothing singling one out -> select, reference null (BARRY will ask). "תוסיף אותה לעגלה אבל אני עוד מסתכלת" -> select, purchaseDecision false. "היא יפה" -> commerce null.
- customerFacts: details the customer states about THEMSELVES in this message. One item per detail: { field, value, evidence }.
  - field: a plain lowercase field name. When they are answering BARRY's question, use the names in askedFor exactly (e.g. "name", "phone"); otherwise a clear name ("email", "address").
  - value: the detail as they gave it. evidence: the exact text from THIS message that contains it (for a message that is only the detail, the whole message).
  - A verb, a product, a relationship word ("my wife") or anything that isn't their own detail is never a fact. Omit anything not given this turn — never placeholders. Details about someone else (a sister, a partner) are not the customer's.
  - How to address them: when they state it ("I'm a woman", "he/him", "don't call me bro") or their own Hebrew grammar shows it (e.g. "אני מחפשת"), add { field: "address_as", value: "feminine" | "masculine" | the pronouns they gave (e.g. "he/him"), evidence: those exact words }. A correction of their name ("I'm Alex, not Alicia") is a new "name" fact.
- customerClaimsPaymentCompleted: true when the customer says they paid. It is only a claim; BARRY verifies it with the provider.
- purchaseDecision: true when the customer has DECIDED to buy what's being discussed ("I'll take it", "yalla, I'm taking it"); false when they are asking, admiring, comparing, or adding to the cart while still browsing ("add three to the cart" is a cart change, not a decision); null if unclear. It only lets BARRY OFFER checkout per the business playbook — never a request to check out, a payment or an order.
- knowledgeTopic: when they ask about something covered by one of knowledgeTopics, that exact topic string.
- capabilityRequest: when the customer's need is served by one of capabilitySurface's capabilities (and not by the offers/commerce flows above), propose it: the exact capability id, inputJson = a JSON object of its inputs using ONLY values the customer said or that appear in knownCustomerFields/capabilityResults (never invent an id, number or address; for an input that lists options, use exactly one of those options; leave the request null and let BARRY ask if a required input is unknown), and a one-line purpose. Only propose capabilities marked available; one whose authority is not_permitted can't be used for this business, so don't propose it. You never decide whether it is allowed — BARRY does. If capabilityResults already answer the need, don't request it again; propose the NEXT capability only if the result makes it necessary for what the customer wants (e.g. the result shows a problem that another capability on the surface exists to handle), or if the customer asked for several things in this message and one of them is not answered yet (one per step — BARRY re-asks you after each result); otherwise null.
- advancesTransaction: does THIS message move the purchase/booking forward? true when they choose, decide, give the details it needs, accept a time or ask to book/pay; false when they only ask a question (price, policy, product facts, "what can you do"), check status, ask for a recap, browse, chat, or refuse to give details yet ("no phone until I decide" is false). The customer's latest message decides, not the conversation's earlier momentum. null if unclear.
- withdrawsRequest: true when they withdraw, cancel or decline what they asked for ("forget it", "then I'm not buying", "don't send a link", "לא קונה", "תבטל") — including a request BARRY sent to the owner (see pendingOwnerRequests).
- changesPendingRequest: true when a request in pendingOwnerRequests is still waiting and they changed its details (a different reference/number, amount, option). A plain status question ("any news?") is false — it never creates or changes anything.
- replacingRequests (when non-empty): the customer just changed the details of these requests, and they are being replaced. If the customer asked for the corrected request, propose it now as capabilityRequest with the corrected values (same capability, the new reference/reason/amount exactly as they gave it); otherwise null.
- readRequested: true when they ask BARRY to actually check something now — open times, stock ("check the real calendar", "do a real inventory lookup") — whether or not they intend to buy. A read never implies a purchase; set advancesTransaction false if they aren't committing.
- checkoutConsent: true only when they ask to pay / check out / complete the order now, or accept BARRY's offer to check out ("yes, let's pay"); false when they say not to ("just change the size, don't check out", "no payment yet", "I'm not ready to check out"); null otherwise. Choosing, adding or changing an item is never checkout consent by itself — purchaseDecision is separate.
- constraints.budgetMax: a hard maximum the customer set for what they'll pay (a number); budgetIncludesShipping true when they said it includes everything / shipping. null if none.
- withdrawScope: when withdrawsRequest, the identifiers (references, numbers) of exactly the requests being withdrawn; [] when they withdraw everything. "Don't reopen A" about an already-closed A is NOT a withdrawal of anything else.
- readRequested is false for a question about the STATUS of their own order/booking/request — that's answered from BARRY's records, not a lookup.
- constraints.quantity: how many units they want of what's being discussed (a correction replaces the earlier number); null if they didn't say.
- Scheduling: describe what they said, never compute timestamps. A window's end and exclusivity are part of it: "15:15-15:45" -> hour 15 minute 15, endHour 15 endMinute 45; "after 3" / "strictly after 15:00" -> hour 15, startExclusive true; "before 17:00" -> endHour 17. schedulingWindow fields: dateKind (explicitDate|relativeDay|weekday), isoDate (YYYY-MM-DD, resolve using business.currentDate), relativeDays, weekday (0=Sun..6=Sat), weekdayQualifier (this|next), timeKind (explicitTime|partOfDay), hour/minute (24h, as the customer meant it locally), partOfDay. Keep a day/time stated earlier unless they changed it.
- slotAccepted / slotDeclined: only when awaitingSlotConfirmation is true and they accept or decline the offered time.
- selectedOfferId / offerCandidateIds: for services in "offers"; several plausible -> candidates. offerChangeRequested only for an explicit change of mind to a different real offer.
- requestedCapability: "ask_price" | "ask_duration" | "ask_deposit" when they ask that about an offer; else null.
- asks: every distinct thing the customer asks in THIS message, in order, as a short phrase in their words; kind "change" (add/remove/change/book/buy/open/cancel — anything that would change something), "question" (facts, policy, price), "status" (what happened to something), "other". coveredByThisIR is true for the ask(s) the other fields of this IR describe (one change at a time), false for the rest. topic: for a question about something covered by one of knowledgeTopics, that exact topic string (else null) — set it even when the message also changes something. A plain message is one ask.
- handoffRequested: true when the customer asks for a human/the owner/"someone", or needs something that isn't in capabilitySurface/offers and only a person could resolve (a complaint, a dispute, an exception). handoffReason: one short line of why, in plain words. handoffUrgency "urgent" only for something time-critical or a serious complaint. BARRY's runtime records the handoff; you never promise anything yourself.
- alreadyDoneThisTurn / remainingAsks (when non-empty): part of this message was already carried out. Describe ONLY the first of remainingAsks in the action fields (commerce / capabilityRequest / …) and mark it coveredByThisIR; never repeat what is already done. If it can't be described (needs a choice or a detail), leave the action fields null.
- Output strict JSON only.`;

/**
 * Live bug fixed by this prompt: after checkAvailability had ALREADY
 * returned slots, BARRY told the customer "I'll check availability and
 * get back to you shortly" — a future-tense claim about something that
 * had already happened, because the model was free to phrase the JSON
 * summary however it liked. `toolSucceeded`/`toolOutput` being present
 * means the action is DONE; the model only ever describes the result.
 */
const POLICY_CHECK_PROMPT = `You check a customer-service reply against the business's OWN policy texts (any language).
List every sentence of the reply that states a business policy DIFFERENTLY from the texts: a limitation turned into a prohibition or the reverse ("exchange only" means exchanges ARE allowed and refunds are not), a scope word dropped (only / except / within / unless), a condition or time limit changed, or a policy detail the texts don't contain stated as fact. Paraphrase and translation are fine when the meaning is the same. Sentences that aren't about policy are not contradictions. Return {"contradictions": []} when everything agrees.`;

const ASK_COVERAGE_PROMPT = `You check whether a customer-service reply addresses EVERY one of the customer's asks (any language).
Each ask has a status saying what really happened. An ask is addressed when the reply deals with it consistently with its status (answers the question, reports the change, says it awaits approval, says what is needed, or says plainly it can't/didn't happen). Return the indexes (0-based) of asks the reply does NOT address at all: {"missing": []} when all are addressed.`;

const ASK_COVERAGE_SCHEMA = {
  name: "ask_coverage",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { missing: { type: "array", items: { type: "integer" } } },
    required: ["missing"],
  },
};

const POLICY_CHECK_SCHEMA = {
  name: "policy_check",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      contradictions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { sentence: { type: "string" }, policy: { type: "string" }, why: { type: "string" } },
          required: ["sentence", "policy", "why"],
        },
      },
    },
    required: ["contradictions"],
  },
};

export const COMPOSE_SYSTEM_PROMPT =
  `${BARRY_CONSTITUTION}\n\nYOUR TASK NOW: write BARRY's next message to the customer, as an employee of \`business\` would. ` +
  // ── What you're given
  "The JSON below is the ONLY source of truth for what happened — describe exactly that, never inventing a price, availability, capability or outcome beyond it. " +
  "`recentConversation` is what was said before (oldest first) and `lastCustomerMessage` is what they just wrote: continue THAT conversation — don't greet again, don't re-introduce yourself, don't re-ask anything already answered there, and keep their register and pace. " +
  "`whatTheBusinessCanDo` is everything this business offers and can help with. If the customer wants something that isn't there, say briefly that it's not something we do here and offer the closest thing that is there (or say the team can help) — never collect details for it and never promise it. " +
  // ── What happened, and the facts
  "`ledger` is the permanent record of every operation in this conversation and its REAL outcome (`happened`). Transport success is not an outcome: a payment check that says pending means NOT paid; a request waiting on the owner means NOT done; submitted-but-unconfirmed means you can't say it's done. Never state an outcome the ledger doesn't show — including for earlier turns, whatever earlier messages said. Each entry's `reference` belongs only to that entry's `terms`: when asked about several references, answer each one from its own entry (opened with its number / declined / withdrawn / not opened). " +
  "If `writeBlocked` is present, the payment/checkout was NOT created because it would break the customer's own consent or limits (reason: outside_consent_scope = the cart has items they didn't consent to — list them; over_budget = total above their cap; shipping_unknown = can't prove the all-in total stays under their cap): say exactly that with its numbers, and that nothing was sent or charged. If `revisionWithoutReplacement` is true, the earlier request was cancelled because they changed its details and NO new request exists yet: say nothing is waiting on the owner now and what's needed to send the corrected one. " +
  "`pricing` is THE quote (quantity, discount, shipping, total) — state its total exactly; never compute an amount yourself. If pricing.complete is false the shipping cost is unknown: say the total excludes shipping. " +
  "Availability/stock can be stated only from a `ledger` entry with thisTurn true that looked it up (or facts.shownProducts); otherwise say you'd need to check. " +
  "If `repairRequired` is present, your draft (yourDraft) stated things BARRY cannot support (problems). Rewrite the WHOLE reply from the facts and ledger: remove every unsupported statement AND every conclusion that depended on it (e.g. with unknown dimensions you cannot say whether something fits; with no booking in the ledger, nothing is booked). Keep what was correct. " +
  "`receipts` is THE record of what BARRY did for this reply. Say something was done ONLY when a receipt shows it: result \"done\" = done; \"done_unconfirmed\" = submitted but not confirmed yet; \"not_done\"/\"failed\" = it didn't happen; \"sent_to_owner\" = you've asked the owner; \"still_with_owner\" = still waiting, nothing new was sent; \"owner_declined_earlier\" = the owner already declined those terms, not sent again; \"not_allowed\" = we can't do that. Describe each receipt as exactly that operation — never as something else the customer asked for. If the customer asked for several things and a receipt doesn't cover one, that one was NOT done: say so plainly (and if it isn't in whatTheBusinessCanDo, that we can't do it here). Your own earlier messages are never proof; if one of them claimed something `transaction`/`ownerRequests`/receipts contradict, correct it. " +
  "Only BARRY's runtime can send something to the owner. Mention the owner only when ownerApproval, receipts or ownerRequests show a request; otherwise never say you passed, will pass, or are waiting on anything with the owner. For status questions answer from ownerRequests (approved and done — with its reference; declined; withdrawn; still waiting). " +
  "Prices, deposits, durations, policies, product details and availability come ONLY from `facts`, receipts/toolOutput and scheduling. Quote prices exactly as written in facts. Never say something is available/in stock unless a receipt that looked up times or stock shows it now (or facts.shownProducts says so). Never state a measurement, colour, fit or specification that isn't in facts — say you don't have that detail. Never recommend something above a budget the customer stated; say nothing fits it instead. A total is computed only from those prices, the quantity and the business's own stated discount/shipping rules, and answering it never requires contact details. " +
  "Recaps and status questions (\"what did we agree\", \"is it booked\", \"did you send a link\") are answered from `transaction` and `ownerRequests` — the latest correction wins; answer yes/no first when asked. " +
  "`business.name` is the BUSINESS, never the customer: address the customer only by `customer.name` (or not by name at all). " +
  "Business policies (facts.knowledge) are restated FAITHFULLY: keep every scope word (only, except, within, unless) and never turn a limitation into a prohibition or the reverse — \"sale items can be exchanged only\" means exchanges ARE allowed and refunds are not. If unsure, quote the policy. " +
  "LIFECYCLE: a request waiting for the owner is AWAITING APPROVAL — say it's waiting for approval (you may say you updated or sent the request); never say it was opened, created, booked, sent, paid or refunded until a receipt shows it done. A handoff means the team can see the conversation — never that someone already contacted the customer. " +
  "`facts.provenance` says where each group of facts comes from; general knowledge about businesses of this kind is never a fact about THIS business. " +
  "Opening hours, days, dates, deadlines and policy details (e.g. when a returns period starts) come ONLY from `facts`: if facts don't state it, say you don't have that detail — never fill it in from general knowledge. " +
  "If `handoff` is present, BARRY passed this conversation to the business's team: say so in one line. If handoff.responseCommitted is true, you may say how the team follows up exactly as handoff.how says; if false, say the team can see the conversation but you can't promise when or how they'll reply. Never promise a call, email or contact the handoff doesn't state. " +
  "If `customerAsks` is present, address EVERY ask in it according to its status — answered (answer it; answerFromPolicy is the business's own text, restated faithfully), completed (say it's done), awaiting_approval (waiting for the owner), needs_info (ask for what's needed), blocked (say it can't be done), handoff (the team will see it), not_done (say plainly you don't have that / didn't do it). Never drop an ask to fix another part of the reply. " +
  "If `notDone` is present, those things the customer asked for were NOT done this turn: say so plainly for each (and offer to do them next) — never imply they happened. " +
  "Never narrate an action that no receipt shows happening THIS turn — not as done, not as \"now doing\", not as \"next I'll\". If the customer asked for several things and only some were done, say which were done and which were not (and offer to do the rest). " +
  "Use `customer` (their name, how to address them): never ask for something already there, and never ask for contact details unless outcome/next asks for them. Answer every question in lastCustomerMessage; if one can't be answered from facts, say so. If they asked for a yes/no, a price only, or no more suggestions, do exactly that. " +
  "When outcome.kind is \"conversation\", nothing was executed: answer from facts only. When it is \"withdrawn\", confirm you've stopped and nothing more will be sent (and that the request waiting on the owner was withdrawn when withdrawnRequests > 0). " +
  // ── Language
  "Reply in the language given by `replyLanguage` (mirror the language of replyLanguage.basedOn when present; code is a hint). " +
  "A customer message that is only a phone number, email, code, link or emoji never changes the language. " +
  "In Hebrew, address the customer in their grammatical gender when their own words reveal it (e.g. they wrote מחפשת/רציתי להזמין as a woman -> feminine); otherwise use neutral phrasing — never slash forms like את/ה. " +
  "Money is written the way people write it: a currency code becomes its symbol (ILS -> ₪, USD -> $, EUR -> €). Status or enum values (anything_like_this) become plain words. " +
  // ── Approvals and refusals
  "If `ownerApproval.requestedNow` is set, BARRY has ALREADY asked the owner and will come back to the customer in this chat: say so in one short line (e.g. that you're checking it with the owner and will update them here). Never ask the customer whether to request it or how to proceed, never quote a rule, limit or reason. " +
  "If `ownerApproval.requestedEarlier` is set, that earlier request is still open — if they ask about it, say you're still waiting on the owner. " +
  "If `notSomethingWeDo` is true, the business doesn't allow this: say so briefly and kindly without citing any rule, and offer the closest thing from whatTheBusinessCanDo or the team. " +
  "If `ownerDecision` is \"approved\", the owner said yes and the result follows; if \"declined\", the owner couldn't approve it — say so kindly, without blame, and offer what IS possible. " +
  // ── Results
  "If toolSucceeded is true or false, the action has ALREADY RUN — describe its result " +
  "(toolOutput on success; on failure a brief, honest apology in plain words — never the raw error text — and a real next step). NEVER say you will " +
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
  "Graph's own required fields say otherwise. Ask for them in one natural sentence, not a list or a form. " +
  "If `steps` is present, BARRY took several actions this turn and ALL of them already happened: " +
  "say briefly where things now stand (the end result, not a log of each step), then ask for the ONE thing in `next` if present. " +
  "When an action is \"invokeCapability\", toolOutput.output is what the business's own system returned: answer the customer from exactly those facts, in human words (what it means for them, not field names or raw values). If toolOutput.verified is false for something that changes the world, or toolOutput.ok is false, never say it was done. " +
  "When outcome.kind is \"capability_needs_input\", ask for exactly the listed fields, nothing else. " +
  "When outcome.kind is \"checkout_needs_info\", the customer has decided to buy: ask only for those details so BARRY can send the payment link — never ask whether they want to continue. " +
  // ── Voice
  "Follow `playbook.salesStyle` when present; mention at most one genuinely relevant suggestion and only if playbook.suggestions is \"one_relevant\" — and none when the customer only asked for information or is upset. " +
  "Never name internal things: no action, tool or capability names, no system or provider names beyond what the customer already knows, no rule ids, no field names from this JSON. " +
  "Keep it short — usually 1-3 sentences; for a quick question, one. No preamble, no repeating their message back, no sign-off filler, no headers, no JSON.";

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
  const end = raw.endHour !== null && raw.endHour !== undefined ? { hour: raw.endHour, minute: raw.endMinute ?? 0 } : undefined;
  return { date, time, ...(end ? { end } : {}), ...(raw.startExclusive ? { startExclusive: true } : {}) };
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
      quantity: raw.constraints.quantity && raw.constraints.quantity > 0 ? raw.constraints.quantity : undefined,
      budgetMax: raw.constraints.budgetMax && raw.constraints.budgetMax > 0 ? raw.constraints.budgetMax : undefined,
      budgetIncludesShipping: raw.constraints.budgetIncludesShipping ?? undefined,
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
    advancesTransaction: raw.advancesTransaction ?? undefined,
    withdrawsRequest: raw.withdrawsRequest ? true : undefined,
    changesPendingRequest: raw.changesPendingRequest ? true : undefined,
    readRequested: raw.readRequested ? true : undefined,
    checkoutConsent: raw.checkoutConsent ?? undefined,
    withdrawScope: raw.withdrawScope?.length ? raw.withdrawScope : undefined,
    handoff: raw.handoffRequested ? { reason: (raw.handoffReason ?? "").slice(0, 300) || "the customer asked for a person", urgency: raw.handoffUrgency === "urgent" ? "urgent" : "normal" } : undefined,
    asks: raw.asks.length ? raw.asks.slice(0, 8).map((a) => ({ ask: a.ask.slice(0, 200), kind: a.kind, coveredByThisIR: a.coveredByThisIR, ...(a.topic ? { topic: a.topic.slice(0, 200) } : {}) })) : undefined,
  };
}

/** The model's capability proposal, parsed as untrusted data: a JSON OBJECT of inputs, bounded, or nothing. */
function parseCapabilityRequest(raw: LlmIR["capabilityRequest"]): BarryIR["capabilityRequest"] {
  if (!raw || !raw.capability || raw.inputJson.length > 4000) return undefined;
  let input: unknown;
  try {
    input = raw.inputJson.trim() ? JSON.parse(raw.inputJson) : {};
  } catch {
    return undefined;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return { capability: raw.capability, input: input as Record<string, unknown>, purpose: raw.purpose.slice(0, 300) };
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
    ...(raw.subjectTitle?.trim() ? { subject: raw.subjectTitle.trim().slice(0, 120) } : {}),
    ...(raw.keepTitles?.length ? { keep: raw.keepTitles.map((t) => t.trim().slice(0, 120)).filter(Boolean).slice(0, 10) } : {}),
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

export type ParseIRResult =
  | { ok: true; ir: BarryIR; salvagedFields?: string[]; failClosed?: boolean }
  | { ok: false; kind: "json_parse_error" | "schema_validation_error"; detail: string };

export type ComposeSummaryContext = {
  businessTone: unknown;
  lastCustomerMessage: string;
  responseStatus?: ComposeResponseStatus;
  /** The business's own operating playbook (sales style, suggestions) — overrides general habits. */
  playbook?: { salesStyle: string | null; suggestions: string };
  /** Who BARRY speaks for — the Genome's identity, so the reply sounds like THIS business. */
  business?: { name: string; description?: string };
  /** The last few messages, oldest first, so the reply continues the conversation instead of restarting it. */
  recentConversation?: { from: "customer" | "business"; text: string }[];
  /** What this business does and can help with — so "we can't do that" is derived, never invented. */
  whatTheBusinessCanDo?: BusinessAbilities;
  /** BARRY is already waiting on the owner for something earlier in this conversation. */
  waitingOnOwnerFromEarlier?: boolean;
  /** Exact business facts (offers with prices, knowledge, shown products, cart). */
  facts?: ReturnType<typeof businessFacts>;
  /** What the customer told BARRY about themselves. */
  customer?: Record<string, string>;
  /** Where the transaction really stands. */
  transaction?: ReturnType<typeof transactionFacts>;
  /** Every request sent to the owner in this conversation, with its real status/outcome. */
  ownerRequests?: NonNullable<ReasonerContext["grounded"]>["ownerRequests"];
  /** The conversation's effect ledger, customer-safe. */
  ledger?: { what: string; happened: string; terms: Record<string, string | number>; reference?: string; outcome?: Record<string, string | number | boolean>; thisTurn: boolean }[];
};

export type BusinessAbilities = {
  offers: string[];
  sellsFromCatalog: boolean;
  answersQuestionsAbout: string[];
  /** Things BARRY can do (its enabled operations and the business's own systems), in plain words. */
  canHelpWith: string[];
  /** Things BARRY can start but the owner signs off on. */
  withOwnerSignOff: string[];
};

/**
 * The business's abilities, in plain words, from the Genome and the capability surface — the same
 * sources the runtime acts on. Capability ids, systems and rule text are deliberately left out:
 * the composer only needs what the business can do, never how.
 */
/** BARRY's typed operations a business can enable, in plain words (identical for every business). */
const TYPED_ABILITIES: Record<string, string> = {
  checkAvailability: "check open times for the bookable services",
  createBooking: "book a new appointment for a bookable service (not look up, move or cancel an existing one)",
  createPaymentRequest: "send a payment link",
  checkInventory: "check stock",
  createLead: "record a new enquiry/quote request for the team (not edit one already recorded)",
  createFollowUp: "schedule a follow-up message",
  searchProducts: "search the product catalog",
  addToCart: "add products to the cart and change cart quantities/options",
  createCommerceCheckout: "send a secure checkout link for the cart",
  verifyPayment: "check whether a payment went through",
  requestApproval: "ask the owner to approve something the business's rules require approval for (a discount beyond the automatic limit, a custom price) — only BARRY's runtime sends these",
};

export function businessAbilities(ctx: ReasonerContext): BusinessAbilities {
  const surface = (ctx.grounded?.capabilities ?? []).filter((c) => c.available);
  const typed = ctx.graph.availableActions.filter((a) => a.enabled && TYPED_ABILITIES[a.name]).map((a) => TYPED_ABILITIES[a.name]);
  return {
    offers: ctx.graph.offers.filter((o) => o.active).map((o) => o.name),
    sellsFromCatalog: Boolean(ctx.grounded?.catalog),
    answersQuestionsAbout: ctx.graph.knowledge.map((k) => k.topic),
    canHelpWith: [...typed, ...surface.filter((c) => c.authority === "automatic" || c.authority === "conditional").map((c) => c.purpose)],
    withOwnerSignOff: surface.filter((c) => c.authority === "owner_approval").map((c) => c.purpose),
  };
}

/** The conversation before the customer's latest message (which the summary carries on its own). */
function earlierTurns(turns: NonNullable<ComposeSummaryContext["recentConversation"]>) {
  return turns.at(-1)?.from === "customer" ? turns.slice(0, -1) : turns;
}

/** The recent conversation, as the composer sees it (text only — rich payloads are the channel's). */
export function recentConversation(ctx: ReasonerContext, limit = COMPOSE_HISTORY): NonNullable<ComposeSummaryContext["recentConversation"]> {
  return ctx.state.messages
    .filter((m) => m.role === "customer" || m.role === "barry")
    .slice(-limit)
    .map((m) => ({ from: m.role === "customer" ? ("customer" as const) : ("business" as const), text: m.content }));
}

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
    business: context.business ?? null,
    businessTone: context.businessTone,
    whatTheBusinessCanDo: context.whatTheBusinessCanDo ?? null,
    recentConversation: context.recentConversation ?? [],
    lastCustomerMessage: context.lastCustomerMessage,
    outcome: sanitizeOutcomeForCompose(sanitizedInput.outcome),
    // Customer-safe approval state. The rule text that triggered it is internal and never reaches the reply.
    ownerApproval: sanitizedInput.policyReason
      ? { requestedNow: true, customerWillHearBackHere: true }
      : sanitizedInput.existingOwnerRequest === "still_pending" || context.waitingOnOwnerFromEarlier
        ? { requestedEarlier: true, stillWaiting: true, nothingNewWasSent: sanitizedInput.existingOwnerRequest === "still_pending" || undefined }
        : sanitizedInput.existingOwnerRequest === "declined_earlier"
          ? { ownerAlreadyDeclinedTheseTerms: true, notSentAgain: true }
          : null,
    // THE record of what BARRY did for this reply: only these operations happened, with exactly these results.
    receipts: customerReceipts(sanitizedInput),
    // The permanent effect ledger of this conversation: each entry is one operation with its own frozen
    // terms, its own reference and its real domain outcome. A reference belongs ONLY to its own entry's terms.
    ledger: context.ledger ?? [],
    // The final-write gate stopped the payment/checkout: nothing was created; say why with these numbers.
    writeBlocked: sanitizedInput.writeBlocked ?? undefined,
    // A handoff to the business's team exists for this conversation (see the reply rules for handoff).
    handoff: sanitizedInput.handoff ?? undefined,
    // Things the customer asked for in this message that BARRY did NOT do (their words): say plainly they weren't done.
    notDone: sanitizedInput.notDone?.length ? sanitizedInput.notDone : undefined,
    // EVERY ask in the customer's message and what really became of it — address each one (see the reply rules).
    customerAsks: sanitizedInput.asks?.length ? sanitizedInput.asks.map((a) => ({ ask: a.ask, status: a.status, ...(a.answer ? { answerFromPolicy: a.answer.text } : {}) })) : undefined,
    // The customer changed a pending request but no valid replacement exists: nothing is pending now.
    revisionWithoutReplacement: sanitizedInput.revisionWithoutReplacement || undefined,
    // THE amounts: the authoritative quantity-aware quote (never compute a total yourself).
    pricing: sanitizedInput.quote ?? null,
    // Present when your previous draft stated things BARRY can't support: rewrite the WHOLE reply.
    repairRequired: sanitizedInput.repair ? { yourDraft: sanitizedInput.repair.draft, problems: sanitizedInput.repair.problems } : undefined,
    ownerRequests: context.ownerRequests ?? [],
    facts: context.facts ?? null,
    customer: context.customer ?? {},
    transaction: context.transaction ?? null,
    // The business's rules don't allow this at all (reason is internal).
    notSomethingWeDo: sanitizedInput.refused ? true : undefined,
    // This reply follows the owner's decision on an earlier approval request.
    ownerDecision: sanitizedInput.ownerDecision ?? undefined,
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
          waitingForOwner: st.policyReason ? true : undefined,
        }))
      : null,
    // The single thing still needed from the customer, if any.
    next: sanitizedInput.next ? sanitizeOutcomeForCompose(sanitizedInput.next) : null,
  };
}

/** Exactly what the composer model is given for this reply (exported so evals can inspect it). */
export function composeSummaryFor(ctx: ReasonerContext, input: ComposeResponseInput) {
  const lastCustomerMessage = ctx.state.messages.filter((m) => m.role === "customer").at(-1)?.content ?? "";

  return buildComposeSummary(
    {
      business: { name: ctx.graph.business.name, description: ctx.graph.business.description },
      businessTone: ctx.graph.business.tone,
      lastCustomerMessage,
      responseStatus: composeResponseStatus(ctx, input),
      playbook: { salesStyle: ctx.graph.playbook.salesStyle ?? null, suggestions: ctx.graph.playbook.suggestions },
      // Earlier turns; the latest customer message is lastCustomerMessage.
      recentConversation: earlierTurns(recentConversation(ctx)),
      whatTheBusinessCanDo: businessAbilities(ctx),
      waitingOnOwnerFromEarlier: Boolean(ctx.state.pendingApprovalId) && !input.policyReason && !input.existingOwnerRequest,
      facts: businessFacts(ctx, input.language?.code),
      customer: customerFacts(ctx),
      transaction: transactionFacts(ctx, input.language?.code),
      ownerRequests: ctx.grounded?.ownerRequests ?? [],
      ledger: ledgerView(ctx.grounded?.ledger ?? []).map((e) => ({
        what: e.describes,
        happened: effectPhrase(e),
        terms: e.terms,
        ...(e.reference ? { reference: e.reference } : {}),
        ...(e.outcome ? { outcome: e.outcome } : {}),
        thisTurn: e.seq > (ctx.grounded?.turnStartSeq ?? Number.MAX_SAFE_INTEGER),
      })),
    },
    input
  );
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
  if (parsed.success) return { ok: true, ir: sanitizeIR(graph, parsed.data) };

  const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`).join("; ");
  // One malformed field must not throw away everything else the model understood: drop exactly the
  // malformed fields ("not stated") and keep the rest — recorded, never silent. What can't be dropped
  // (the intent, the object itself) still fails.
  const salvaged = salvageIR(json);
  if (!salvaged) return { ok: false, kind: "schema_validation_error", detail };
  const ir = sanitizeIR(graph, salvaged.data);
  // A dropped field that could carry a transaction decision is not guessed: this turn may inform and
  // read, but it neither advances a transaction nor consents to a write.
  const failClosed = salvaged.dropped.some((path) => DECISION_FIELDS.some((f) => path === f || path.startsWith(`${f}.`)));
  return {
    ok: true,
    ir: failClosed ? { ...ir, advancesTransaction: false, checkoutConsent: false, purchaseDecision: false, capabilityRequest: undefined } : ir,
    salvagedFields: salvaged.dropped,
    ...(failClosed ? { failClosed: true } : {}),
  };
}

/** IR fields whose value can decide a write, a withdrawal or a revision. */
const DECISION_FIELDS = [
  "advancesTransaction",
  "withdrawsRequest",
  "withdrawScope",
  "changesPendingRequest",
  "checkoutConsent",
  "purchaseDecision",
  "customerClaimsPaymentCompleted",
  "capabilityRequest",
  "commerce",
  "selectedOfferId",
  "offerChangeRequested",
  "constraints.quantity",
  "constraints.budgetMax",
  "constraints.budgetIncludesShipping",
  "constraints.discountPct",
  "constraints.slotAccepted",
  "constraints.slotDeclined",
];

/**
 * Structural salvage of a schema-invalid understanding: each invalid value is replaced by the
 * schema's own "not stated" (null, or an empty list; an invalid list item is removed). If that value
 * can't be "not stated" either, its enclosing object is. The root and `intent` are never dropped.
 * Purely shape-driven — no field is ever given a meaning the model didn't produce.
 */
export function salvageIR(json: unknown): { data: LlmIR; dropped: string[] } | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const current = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
  const dropped: string[] = [];
  const reset = new Map<string, number>();
  for (let round = 0; round < 32; round++) {
    const result = LlmIRSchema.safeParse(current);
    if (result.success) return { data: result.data, dropped: [...new Set(dropped)] };
    const issue = result.error.issues[0];
    let path = issue.path.map((p) => (typeof p === "number" ? p : String(p)));
    // A value already reset both ways is still invalid: reset what encloses it instead.
    while (path.length > 0 && (reset.get(path.join(".")) ?? 0) >= 2) path = path.slice(0, -1);
    if (path.length === 0 || (path.length === 1 && path[0] === "intent")) return null;
    const key = path.join(".");
    const tries = reset.get(key) ?? 0;
    reset.set(key, tries + 1);
    const parent = path.slice(0, -1).reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string | number, unknown>)[k] : undefined), current);
    const leaf = path[path.length - 1];
    if (!parent || typeof parent !== "object") return null;
    const label = path.filter((p) => typeof p !== "number").join(".");
    dropped.push(label);
    if (Array.isArray(parent) && typeof leaf === "number") {
      parent.splice(leaf, 1);
      reset.delete(key);
      continue;
    }
    // "Not stated" is null for a nullable field, an empty list for a list field.
    (parent as Record<string, unknown>)[String(leaf)] = tries === 0 ? null : [];
  }
  return null;
}

/** Secrets and account identifiers never leave the provider error. */
export function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, "sk-…")
    .replace(/(Bearer\s+)\S+/gi, "$1…")
    .replace(/\b(org|proj|user)-[A-Za-z0-9]{6,}/g, "$1-…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** A provider call failure, classified: what went wrong and whether retrying could help. */
export function classifyProviderError(err: unknown): ModelCallFailure {
  const e = (err ?? {}) as { status?: unknown; code?: unknown; type?: unknown; name?: unknown; error?: { code?: unknown; type?: unknown } };
  const status = typeof e.status === "number" ? e.status : undefined;
  const code = str(e.code) ?? str(e.error?.code) ?? str(e.type) ?? str(e.error?.type);
  const name = `${str(e.name) ?? ""} ${err instanceof Error ? err.constructor.name : ""}`;
  const message = sanitizeProviderMessage(err instanceof Error ? err.message : String(err));
  const base = { ...(status !== undefined ? { status } : {}), ...(code ? { code } : {}), message };
  if (/timeout/i.test(name) || status === 408) return { kind: "provider_timeout", transient: true, ...base };
  if (status === 429)
    return code === "insufficient_quota" || /quota|billing/i.test(message)
      ? { kind: "provider_quota_exhausted", transient: false, ...base }
      : { kind: "provider_rate_limited", transient: true, ...base };
  if (status === 401 || status === 403) return { kind: "provider_auth", transient: false, ...base };
  if (status !== undefined && status >= 500) return { kind: "provider_unavailable", transient: true, ...base };
  if (status !== undefined && status >= 400) return { kind: "provider_rejected_request", transient: false, ...base };
  if (/connection/i.test(name)) return { kind: "provider_connection", transient: true, ...base };
  return { kind: "provider_error", transient: false, ...base };
}

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
    // Provider-level retries with backoff (429 honouring retry-after, 5xx, timeouts, connection errors).
    this.client = new OpenAI({ apiKey, maxRetries: 2 });
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
    let lastFailure: ModelCallFailure | undefined;
    let attempts = 0;

    if (this.configError) {
      return { ir: emptyIR("understanding_failed"), valid: false, attempts: 0, failure: { kind: "invalid_model_config", message: sanitizeProviderMessage(this.configError), transient: false }, latencyMs: 0, usage, model: this.model };
    }

    type Parsed = { ir: BarryIR; salvagedFields?: string[]; failClosed?: boolean };
    const attempt = async (correction?: string): Promise<Parsed | null> => {
      attempts++;
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
        }, "reasoner");
        usage.promptTokens += completion.usage?.prompt_tokens ?? 0;
        usage.completionTokens += completion.usage?.completion_tokens ?? 0;
        usage.reasoningTokens += completion.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
        raw = completion.choices[0]?.message?.content;
      } catch (err) {
        lastFailure = classifyProviderError(err);
        logReasonerFailure("openai_api_error", { kind: lastFailure.kind, status: lastFailure.status, code: lastFailure.code, message: lastFailure.message });
        return null;
      }

      if (!raw) {
        lastFailure = { kind: "empty_completion", message: "the model returned no content", transient: true };
        logReasonerFailure("openai_api_error", { message: "empty completion content" });
        return null;
      }

      const result = parseIRResponse(ctx.graph, raw);
      if (!result.ok) {
        lastFailure = { kind: result.kind, message: result.detail.slice(0, 240), transient: true };
        logReasonerFailure(result.kind, { detail: result.detail });
        return null;
      }
      if (result.salvagedFields?.length) logReasonerFailure("schema_validation_error", { salvaged: result.salvagedFields, failClosed: Boolean(result.failClosed) });
      return result;
    };

    const done = (r: Parsed): UnderstandingResult => ({
      ir: r.ir,
      valid: true,
      attempts,
      ...(lastFailure ? { failure: lastFailure } : {}),
      ...(r.salvagedFields?.length ? { salvagedFields: r.salvagedFields } : {}),
      ...(r.failClosed ? { failClosed: true } : {}),
      latencyMs: Date.now() - started,
      usage,
      model: this.model,
    });

    const first = await attempt();
    if (first) return done(first);
    // Provider failures are already retried with backoff by the provider client (429 honouring
    // retry-after, 5xx, timeouts, connection errors). Re-asking at once on top of that only repeats
    // the failure — so only malformed OUTPUT gets one corrective re-ask here.
    if (lastFailure && (lastFailure.kind === "json_parse_error" || lastFailure.kind === "schema_validation_error" || lastFailure.kind === "empty_completion")) {
      const retried = await attempt(`Your previous response was invalid (${lastFailure.message ?? lastFailure.kind}). Respond again with ONLY strict JSON matching the schema.`);
      if (retried) return done(retried);
    }

    logReasonerFailure("semantic_validation_error", { message: "understanding unavailable this turn", kind: lastFailure?.kind });
    return { ir: emptyIR("understanding_failed"), valid: false, attempts, ...(lastFailure ? { failure: lastFailure } : {}), latencyMs: Date.now() - started, usage, model: this.model };
  }

  async checkPolicyConsistency(ctx: ReasonerContext, reply: string, policies: { topic: string; text: string }[]): Promise<PolicyContradiction[] | undefined> {
    if (this.configError || policies.length === 0) return policies.length === 0 ? [] : undefined;
    try {
      const completion = await createCompletion(this.client, {
        model: this.composerModel,
        messages: [
          { role: "system", content: POLICY_CHECK_PROMPT },
          { role: "user", content: JSON.stringify({ businessPolicies: policies, reply }) },
        ],
        response_format: { type: "json_schema", json_schema: POLICY_CHECK_SCHEMA },
        ...samplingParams(this.composerModel, "composer", 0, this.composerReasoningEffort),
      }, "checker");
      const raw = completion.choices[0]?.message?.content;
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as { contradictions?: PolicyContradiction[] };
      return Array.isArray(parsed.contradictions) ? parsed.contradictions.slice(0, 5) : undefined;
    } catch (err) {
      const failure = classifyProviderError(err);
      logReasonerFailure("openai_api_error", { kind: failure.kind, status: failure.status, during: "checkPolicyConsistency" });
      return undefined;
    }
  }

  async checkAskCoverage(ctx: ReasonerContext, reply: string, asks: AskOutcome[]): Promise<number[] | undefined> {
    if (this.configError || asks.length === 0) return asks.length === 0 ? [] : undefined;
    try {
      const completion = await createCompletion(this.client, {
        model: this.composerModel,
        messages: [
          { role: "system", content: ASK_COVERAGE_PROMPT },
          { role: "user", content: JSON.stringify({ asks: asks.map((a, index) => ({ index, ask: a.ask, status: a.status })), reply }) },
        ],
        response_format: { type: "json_schema", json_schema: ASK_COVERAGE_SCHEMA },
        ...samplingParams(this.composerModel, "composer", 0, this.composerReasoningEffort),
      }, "checker");
      const raw = completion.choices[0]?.message?.content;
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as { missing?: unknown };
      return Array.isArray(parsed.missing) ? parsed.missing.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < asks.length) : undefined;
    } catch (err) {
      const failure = classifyProviderError(err);
      logReasonerFailure("openai_api_error", { kind: failure.kind, status: failure.status, during: "checkAskCoverage" });
      return undefined;
    }
  }

  async composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    if (this.configError) return composeDeterministic(input);
    const summary = composeSummaryFor(ctx, input);

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
      ctx.diagnostics?.composerFailures.push({ kind: "empty_completion", message: "the composer returned no content", transient: true });
    } catch (err) {
      const failure = classifyProviderError(err);
      logReasonerFailure("openai_api_error", { kind: failure.kind, status: failure.status, code: failure.code, message: failure.message, during: "composeResponse" });
      // The reply falls back to the deterministic composer — recorded for the turn trace, never silent.
      ctx.diagnostics?.composerFailures.push(failure);
    }

    return composeDeterministic(input);
  }
}
