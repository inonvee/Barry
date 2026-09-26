import OpenAI from "openai";
import type { BusinessGraph } from "@/lib/business-graph";
import { findOffer } from "@/lib/business-graph";
import { listTools } from "@/lib/tools";
import { LlmPlanSchema, type LlmPlan } from "./schemas";
import type { ComposeResponseInput, PlanResult, Reasoner, ReasonerContext } from "./types";

/**
 * LLM-backed Reasoner. Understands and PROPOSES actions; it never executes
 * one, mutates state, or bypasses the Policy Engine — the runtime
 * (`src/lib/runtime/engine.ts`) remains the sole authority for that. This
 * class's only job is: build a small, relevant slice of context, ask the
 * model for a structured plan, validate that plan against Zod AND against
 * the real Business Graph, and hand back something the runtime can trust.
 *
 * If the model proposes an offer id or action name that doesn't actually
 * exist on this business, it is dropped rather than passed through — BARRY
 * never invents facts, and the Policy Engine would deny an unlisted action
 * anyway, but we fail safe before it even gets there.
 */

function allowedActionNames(graph: BusinessGraph): string[] {
  const registered = new Set(listTools().map((t) => t.name));
  return graph.availableActions.filter((a) => a.enabled && registered.has(a.name)).map((a) => a.name);
}

function buildPlanningContext(ctx: ReasonerContext, allowedActions: string[]) {
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
    allowedActions,
    recentMessages,
  };
}

const PLAN_SYSTEM_PROMPT = `You are BARRY, an AI operator understanding a customer conversation for a business.

Rules you must never break:
- Never invent prices, availability, inventory, policies, or business hours. If BARRY needs live data, propose the matching action instead of guessing.
- Only propose an action whose name is in "allowedActions". If nothing fits, set action to null.
- Do not repeat a question the customer already answered — check knownFields and previousMissingFields first.
- Accumulate information across turns: a day/time/party-size/service mentioned earlier and reflected in knownFields/recentMessages is still true unless the customer changed it.
- If the customer's request is ambiguous (e.g. multiple services could fit), set action to null and ask a short clarifying question in "reply".
- Respond in the customer's language (mirror the language of their most recent message).
- Output strict JSON matching the provided schema. Never include explanation outside the JSON.`;

function planJsonSchema() {
  return {
    name: "barry_plan",
    strict: false,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        intent: { type: "string" },
        selectedOfferId: { type: ["string", "null"] },
        entities: { type: "object" },
        knownFieldsUpdate: { type: "object" },
        missingFields: { type: "array", items: { type: "string" } },
        stage: {
          type: "string",
          enum: [
            "discovery",
            "offer_selection",
            "info_gathering",
            "scheduling",
            "payment",
            "confirmation",
            "escalated",
            "closed",
          ],
        },
        goal: {
          type: ["string", "null"],
          enum: ["completePurchase", "bookAppointment", "collectDeposit", "qualifyLead", "requestQuote", null],
        },
        action: {
          type: ["object", "null"],
          properties: {
            name: { type: "string" },
            input: { type: "object" },
          },
          required: ["name", "input"],
        },
        reply: { type: ["string", "null"] },
        rationale: { type: "string" },
      },
      required: ["intent", "selectedOfferId", "stage", "action", "reply"],
    },
  };
}

function fallbackPlan(ctx: ReasonerContext, reply: string): PlanResult {
  return {
    intent: "clarification_needed",
    entities: {},
    stage: ctx.state.stage,
    selectedOfferId: ctx.state.selectedOfferId,
    knownFieldsUpdate: {},
    missingFields: ctx.state.missingFields,
    retrievedOfferIds: [],
    retrievedKnowledgeIds: [],
    action: null,
    directResponse: reply,
  };
}

function sanitizePlan(ctx: ReasonerContext, raw: LlmPlan, allowedActions: string[]): PlanResult {
  const { graph } = ctx;

  const selectedOfferId =
    raw.selectedOfferId && findOffer(graph, raw.selectedOfferId) ? raw.selectedOfferId : undefined;

  let action = raw.action;
  if (action && !allowedActions.includes(action.name)) {
    action = null; // Never let a hallucinated/disallowed action through — the Policy Engine
    // would deny it anyway, but we don't even want it logged as "selected".
  }

  return {
    intent: raw.intent,
    entities: raw.entities,
    goal: raw.goal ?? undefined,
    stage: raw.stage,
    selectedOfferId,
    knownFieldsUpdate: raw.knownFieldsUpdate,
    missingFields: raw.missingFields,
    retrievedOfferIds: selectedOfferId ? [selectedOfferId] : [],
    retrievedKnowledgeIds: [],
    action: action ? { name: action.name, input: action.input as Record<string, unknown> } : null,
    directResponse: action ? undefined : raw.reply ?? "Could you tell me a bit more about what you need?",
  };
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

  async plan(ctx: ReasonerContext): Promise<PlanResult> {
    const allowedActions = allowedActionNames(ctx.graph);
    const context = buildPlanningContext(ctx, allowedActions);

    const attempt = async (correction?: string): Promise<PlanResult | null> => {
      try {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: "system", content: PLAN_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(context) },
            ...(correction ? [{ role: "system" as const, content: correction }] : []),
          ],
          response_format: { type: "json_schema", json_schema: planJsonSchema() },
          temperature: 0.2,
        });
        const raw = completion.choices[0]?.message?.content;
        if (!raw) return null;
        const parsed = LlmPlanSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return null;
        return sanitizePlan(ctx, parsed.data, allowedActions);
      } catch {
        return null;
      }
    };

    const first = await attempt();
    if (first) return first;

    const retried = await attempt(
      "Your previous response was invalid. Respond again with ONLY strict JSON matching the schema."
    );
    if (retried) return retried;

    return fallbackPlan(
      ctx,
      "Sorry, could you say that again? I want to make sure I get the details right."
    );
  }

  async composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    const { plan, toolResult, policyReason } = input;
    if (!plan.action && plan.directResponse) return plan.directResponse;

    const lastCustomerMessage = ctx.state.messages.filter((m) => m.role === "customer").at(-1)?.content ?? "";

    const summary = {
      businessTone: ctx.graph.business.tone,
      lastCustomerMessage,
      action: plan.action?.name ?? null,
      policyReason: policyReason ?? null,
      toolSucceeded: toolResult?.ok ?? null,
      toolOutput: toolResult?.ok ? toolResult.output : undefined,
      toolError: toolResult && !toolResult.ok ? toolResult.error : undefined,
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
              "Only describe what the JSON summary actually says happened — never invent " +
              "prices, availability, or outcomes. If policyReason is set, explain briefly and " +
              "warmly that you're checking with the owner. Keep it to 1-3 sentences, no headers, no JSON.",
          },
          { role: "user", content: JSON.stringify(summary) },
        ],
        temperature: 0.4,
      });
      const text = completion.choices[0]?.message?.content?.trim();
      if (text) return text;
    } catch {
      // fall through to safe default below
    }

    if (policyReason) return `Thanks — I need a quick sign-off from the owner on that. I'll follow up shortly.`;
    if (toolResult && !toolResult.ok) return `Sorry, I ran into an issue with that. Could we try something else?`;
    return "Got it — let me know if there's anything else I can help with.";
  }
}
