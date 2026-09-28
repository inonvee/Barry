import OpenAI from "openai";
import type { BusinessGraph } from "@/lib/business-graph";
import { findOffer } from "@/lib/business-graph";
import { LlmIRSchema, irJsonSchema, type LlmCommerce, type LlmIR, type LlmSchedulingWindow, type KeyValuePair } from "./schemas";
import { catalogForModel } from "@/lib/commerce/catalog";
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

function buildUnderstandingContext(ctx: ReasonerContext) {
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
    offers,
    knowledgeTopics: graph.knowledge.map((k) => k.topic),
    knownCustomerFields: customerFields,
    previousMissingFields: state.missingFields,
    selectedOfferId: state.selectedOfferId ?? null,
    stage: state.stage,
    awaitingSlotConfirmation: Boolean(state.knownFields.__offeredSlotStart && !state.knownFields.__slotAccepted),
    openPaymentRequest: Boolean(state.knownFields.__paymentRequestId && !state.knownFields.__paid),
    // What this business's catalog can be searched by — map the customer's words onto these values.
    catalog: ctx.grounded?.catalog ? catalogForModel(ctx.grounded.catalog) : null,
    shownResults: ctx.grounded?.shownResults ?? [],
    // BARRY just asked which option the customer wants for this shown item.
    awaitingVariantChoiceForProductId: state.knownFields.__commercePendingProductId ?? null,
    cart: ctx.grounded?.cart ?? [],
    cartTotal: ctx.grounded?.cartTotal ?? null,
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
  - select: they chose something BARRY already showed. Use referenceType "previous_result" + referenceIndex (0-based position in shownResults). Put requested options in variant (e.g. size -> "M"). Never invent an index outside shownResults.
  - replace: the cart already has an item and they want a DIFFERENT shown result instead of it ("actually switch to the first one"). referenceType "previous_result" + referenceIndex for the new item; variant if stated.
  - change_variant / change_quantity / remove: they changed an item in the cart (referenceType "cart_line"). If awaitingVariantChoiceForProductId is set and they just name an option ("M"), that answers BARRY's question: use select with that variant and no reference.
  - checkout: they want to pay / complete the purchase.
  - negotiate_price: they ask for a different price (requestedPriceAmount).
- customerInfo: ONLY identity/contact details the customer states about THEMSELVES in this message (name, phone, email, ...). For each one, add an evidence pair { key: "customerInfo.<field>", value: <exact quote from the message> }. A verb, a product, a relationship word ("my wife") or anything that isn't their own name is never a name. Omit fields not given this turn — never use placeholder values.
- customerClaimsPaymentCompleted: true when the customer says they paid. It is only a claim; BARRY verifies it with the provider.
- knowledgeTopic: when they ask about something covered by one of knowledgeTopics, that exact topic string.
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
  "Use the business's tone. Reply in the same language as their last message. " +
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
  "When outcome.kind is \"needs_info\", ask for EXACTLY the fields listed in " +
  "outcome.missingFields — one per field (\"your name\", \"your phone number\"), never more, " +
  "never pluralized or duplicated because of partySize or any other constraint. Only ask " +
  "for a field the Business Graph actually lists as missing; never invent an additional " +
  "requirement (e.g. \"names and phone numbers\" when missingFields is just [\"name\", " +
  "\"phone\"]) — BARRY collects ONE customer's contact info per booking unless the Business " +
  "Graph's own required fields say otherwise. " +
  "Keep it to 1-3 sentences, no headers, no JSON.";

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
    customerInfo: kvArrayToRecord(raw.customerInfo),
    requestedCapability: raw.requestedCapability ?? undefined,
    goal: raw.goal ?? undefined,
    commerce: raw.commerce ? unflattenCommerce(raw.commerce) : undefined,
    customerClaims: raw.customerClaimsPaymentCompleted ? { paymentCompleted: true } : undefined,
    evidence: kvArrayToRecord(raw.evidence),
    knowledgeTopic: raw.knowledgeTopic ?? undefined,
  };
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
      raw.referenceType && raw.referenceIndex !== null ? { type: raw.referenceType, index: raw.referenceIndex } : undefined,
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

function emptyIR(intent: string): BarryIR {
  return { intent, entities: {}, constraints: {}, customerInfo: {} };
}

export class OpenAIReasoner implements Reasoner {
  readonly name = "llm" as const;
  private client: OpenAI;
  private model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set — cannot construct OpenAIReasoner.");
    this.client = new OpenAI({ apiKey });
    this.model = process.env.BARRY_MODEL || "gpt-4o-mini";
  }

  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    const context = buildUnderstandingContext(ctx);

    const attempt = async (correction?: string): Promise<BarryIR | null> => {
      let raw: string | null | undefined;
      try {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: "system", content: UNDERSTAND_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(context) },
            ...(correction ? [{ role: "system" as const, content: correction }] : []),
          ],
          response_format: { type: "json_schema", json_schema: irJsonSchema() },
          temperature: 0.2,
        });
        raw = completion.choices[0]?.message?.content;
      } catch (err) {
        logReasonerFailure("openai_api_error", { message: err instanceof Error ? err.message : String(err) });
        return null;
      }

      if (!raw) {
        logReasonerFailure("openai_api_error", { message: "empty completion content" });
        return null;
      }

      const result = parseIRResponse(ctx.graph, raw);
      if (!result.ok) {
        logReasonerFailure(result.kind, { detail: result.detail });
        return null;
      }
      return result.ir;
    };

    const first = await attempt();
    if (first) return first;

    const retried = await attempt(
      "Your previous response was invalid. Respond again with ONLY strict JSON matching the schema."
    );
    if (retried) return retried;

    logReasonerFailure("semantic_validation_error", {
      message: "both understanding attempts failed; falling back to empty IR",
    });
    return emptyIR("understanding_failed");
  }

  async composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    const lastCustomerMessage = ctx.state.messages.filter((m) => m.role === "customer").at(-1)?.content ?? "";

    const summary = buildComposeSummary(
      { businessTone: ctx.graph.business.tone, lastCustomerMessage, responseStatus: composeResponseStatus(ctx, input) },
      input
    );

    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: COMPOSE_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(summary) },
        ],
        temperature: 0.4,
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
