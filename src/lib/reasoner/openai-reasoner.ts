import OpenAI from "openai";
import type { BusinessGraph } from "@/lib/business-graph";
import { findOffer } from "@/lib/business-graph";
import { LlmIRSchema, irJsonSchema, type LlmIR, type KeyValuePair } from "./schemas";
import { composeDeterministic } from "./deterministic-compose";
import { logReasonerFailure } from "./diagnostics";
import type { BarryIR, ComposeResponseInput, Reasoner, ReasonerContext } from "./types";

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

  return {
    business: { name: graph.business.name, tone: graph.business.tone, locale: graph.business.locale },
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
"entities" and "knownFieldsUpdate" are arrays of { key, value } pairs, not
objects, because the schema can't express an open-ended dictionary.

Rules you must never break:
- Never invent prices, availability, inventory, policies, business hours, or payment status — you don't decide those; you only extract what the customer said.
- "constraints.schedulingWindow.earliest" must be a real ISO datetime you computed from what the customer said (a day/time), or null if none was mentioned this turn — never a placeholder.
- Accumulate information across turns: a day/time/party-size/service mentioned earlier (visible in knownFields/recentMessages) is still true unless the customer changed it — repeat it in constraints/knownFieldsUpdate so it isn't lost.
- If multiple offers plausibly match, list them in offerCandidateIds and leave selectedOfferId null — do not guess.
- requestedCapability is advisory only (e.g. "ask_price" when they ask how much something costs). Use null if unsure.
- Output strict JSON matching the provided schema. No explanation outside the JSON.`;

function kvArrayToRecord(pairs: KeyValuePair[]): Record<string, string> {
  return Object.fromEntries(pairs.map((p) => [p.key, p.value]));
}

/** Never trust the model's offer id/candidates without checking they exist on this business. */
export function sanitizeIR(graph: BusinessGraph, raw: LlmIR): BarryIR {
  const selectedOfferId =
    raw.selectedOfferId && findOffer(graph, raw.selectedOfferId) ? raw.selectedOfferId : undefined;

  const offerCandidateIds = raw.offerCandidateIds.filter((id) => findOffer(graph, id));

  return {
    intent: raw.intent,
    selectedOfferId,
    offerCandidateIds: offerCandidateIds.length > 0 ? offerCandidateIds : undefined,
    entities: kvArrayToRecord(raw.entities),
    constraints: {
      schedulingWindow:
        raw.constraints.schedulingWindow?.earliest
          ? { earliest: raw.constraints.schedulingWindow.earliest, latest: raw.constraints.schedulingWindow.latest ?? undefined }
          : undefined,
      partySize: raw.constraints.partySize ?? undefined,
      discountPct: raw.constraints.discountPct ?? undefined,
      slotAccepted: raw.constraints.slotAccepted ?? undefined,
    },
    knownFieldsUpdate: kvArrayToRecord(raw.knownFieldsUpdate),
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
  return { intent, entities: {}, constraints: {}, knownFieldsUpdate: {} };
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
    };

    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "You are BARRY, a helpful employee of this business, replying to a customer. " +
              "Use the business's tone. Reply in the same language as their last message. " +
              "The JSON summary below is the ONLY source of truth for what happened — " +
              "describe exactly that, never inventing a price, availability, or outcome beyond it. " +
              "If policyReason is set, explain briefly and warmly that you're checking with the owner. " +
              "Keep it to 1-3 sentences, no headers, no JSON.",
          },
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
