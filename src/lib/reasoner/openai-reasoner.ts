import OpenAI from "openai";
import type { BusinessGraph } from "@/lib/business-graph";
import { findOffer } from "@/lib/business-graph";
import { LlmIRSchema, irJsonSchema, type LlmIR, type LlmSchedulingWindow, type KeyValuePair } from "./schemas";
import { composeDeterministic } from "./deterministic-compose";
import { logReasonerFailure } from "./diagnostics";
import type { BarryIR, ComposeResponseInput, Reasoner, ReasonerContext } from "./types";
import type { SchedulingConstraint } from "@/lib/scheduling/resolver";

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

  return {
    business: {
      name: graph.business.name,
      tone: graph.business.tone,
      locale: graph.business.locale,
      timezone: graph.business.timezone,
      currentDate: currentDateInBusinessTimezone,
    },
    offers,
    knownFields: state.knownFields,
    previousMissingFields: state.missingFields,
    selectedOfferId: state.selectedOfferId ?? null,
    stage: state.stage,
    recentMessages,
  };
}

const UNDERSTAND_SYSTEM_PROMPT = `You are BARRY's understanding layer for a customer conversation. Your ONLY
job is to turn the customer's message into structured IR (intent, entities,
constraints, known-field updates). You do NOT decide what BARRY does next —
a separate deterministic system does that from the Business Graph. You have
no tools and cannot execute anything.

Every field in the schema is always present in your response. Use null for
"not applicable" and an empty array for "none" — never omit a field.
"entities" and "customerInfo" are arrays of { key, value } pairs, not
objects, because the schema can't express an open-ended dictionary.

"entities" vs "customerInfo" — these are NOT duplicates and must never
both hold the same fact: "entities" is a free-form, debug-only bag for
whatever semantic details you noticed (never read by anything that
changes what BARRY does). "customerInfo" is the ONE AND ONLY channel
for customer-provided identity/contact fields (name, phone, email, or
any other field the business needs from the customer) — this is what
actually gets remembered. If the customer gives you their name or phone
number, you MUST put it in "customerInfo", not just "entities". Report
each fact exactly once, in "customerInfo".

SCHEDULING — read carefully: you describe what the customer said, you
never compute a timestamp. "constraints.schedulingWindow" only has these
fields: dateKind ("explicitDate" | "relativeDay" | "weekday" | null),
isoDate (only for explicitDate, "YYYY-MM-DD" — use business.currentDate to
resolve an ambiguous bare day/month), relativeDays (only for relativeDay:
0=today, 1=tomorrow, 2=day after...), weekday (only for weekday: 0=Sun..
6=Sat), weekdayQualifier ("this" | "next" | null — "next Monday" is
"next", bare "Monday" is null/"this"), timeKind ("explicitTime" |
"partOfDay" | null), hour/minute (only for explicitTime, 24-hour, exactly
as the customer said it in their own local sense of time — never convert
it yourself, never add a timezone offset), partOfDay (only for
partOfDay). Leave every field you're not using as null — never invent an
ISO datetime string anywhere.

Rules you must never break:
- Never invent prices, availability, inventory, policies, business hours, or payment status — you don't decide those; you only extract what the customer said.
- customerInfo must contain ONLY fields the customer's message actually gave a real value for THIS turn. If they didn't mention a field, LEAVE IT OUT of the array entirely — never include a pair like {key:"name", value:"null"} (or "undefined"/"none"/"N/A"/empty string) as a placeholder for "nothing to report." An omitted key means no update; it does NOT mean "clear the existing value."
- Accumulate information across turns: a day/time/party-size/service mentioned earlier (visible in knownFields/recentMessages) is still true unless the customer changed it — repeat it in constraints so it isn't lost. (customerInfo itself only ever needs a NEW value this turn; already-known customer fields are already in the knownFields context and don't need repeating.)
- If multiple offers plausibly match, list them in offerCandidateIds and leave selectedOfferId null — do not guess.
- selectedOfferId/offerCandidateIds are ONLY for the initial choice of offer. If "selectedOfferId" (given to you in context) is already set and the customer's message is an EXPLICIT change of mind ("actually, X instead", "change it to X", "switch to X") naming a different, real offer, put that offer's id in offerChangeRequested instead — never in selectedOfferId. Leave offerChangeRequested null for anything that isn't an explicit, confident change request; an unrelated message must never change the offer.
- requestedCapability is advisory only: "ask_price" when they ask how much something costs, "ask_duration" when they ask how long it takes, "ask_deposit" when they ask about a deposit or upfront payment requirement. Use null if unsure.
- Output strict JSON matching the provided schema. No explanation outside the JSON.`;

/**
 * Live bug fixed by this prompt: after checkAvailability had ALREADY
 * returned slots, BARRY told the customer "I'll check availability and
 * get back to you shortly" — a future-tense claim about something that
 * had already happened, because the model was free to phrase the JSON
 * summary however it liked. `toolSucceeded`/`toolOutput` being present
 * means the action is DONE; the model only ever describes the result.
 */
export const COMPOSE_SYSTEM_PROMPT =
  "You are BARRY, a helpful employee of this business, replying to a customer. " +
  "Use the business's tone. Reply in the same language as their last message. " +
  "The JSON summary below is the ONLY source of truth for what happened — " +
  "describe exactly that, never inventing a price, availability, or outcome beyond it. " +
  "If policyReason is set, explain briefly and warmly that you're checking with the owner. " +
  "If toolSucceeded is true or false, the action has ALREADY RUN — describe its result " +
  "(toolOutput on success, a brief apology and alternative on failure). NEVER say you will " +
  "check, look up, confirm, or get back to them later for something toolOutput/toolError " +
  "already answers — phrases like \"I'll check\" or \"I'll get back to you shortly\" are " +
  "forbidden whenever a tool already ran this turn. " +
  "If `scheduling` is present, any date/time you mention MUST use its localDate/localTime " +
  "strings verbatim — never compute, convert, or reinterpret a time yourself from any raw " +
  "ISO timestamp elsewhere in this JSON (that is always UTC, not the customer's local time). " +
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
    },
    customerInfo: kvArrayToRecord(raw.customerInfo),
    requestedCapability: raw.requestedCapability ?? undefined,
    goal: raw.goal ?? undefined,
  };
}

export type ParseIRResult = { ok: true; ir: BarryIR } | { ok: false; kind: "json_parse_error" | "schema_validation_error"; detail: string };

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

    const summary = {
      businessTone: ctx.graph.business.tone,
      lastCustomerMessage,
      outcome: input.outcome,
      policyReason: input.policyReason ?? null,
      toolSucceeded: input.toolResult?.ok ?? null,
      toolOutput: input.toolResult?.ok ? input.toolResult.output : undefined,
      toolError: input.toolResult && !input.toolResult.ok ? input.toolResult.error : undefined,
      // Pre-computed, business-timezone-local display facts for any
      // scheduling instant this turn — the ONLY source of truth for
      // "what time is that for the customer." Never present when there's
      // nothing scheduling-related to phrase.
      scheduling: input.scheduling ?? null,
    };

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
      if (text) return text;
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
