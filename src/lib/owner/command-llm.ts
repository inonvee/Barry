import OpenAI from "openai";
import { z } from "zod";
import { createCompletion, modelFor, samplingParams } from "@/lib/reasoner/model-config";
import type { CommandIntent } from "./command";

/**
 * THE MODEL'S PART IN OWNER COMMANDS — language only, never authority.
 *
 * The deterministic interpreter (lib/owner/command) runs first. Only when it can't place a message does the
 * model classify it, into a CLOSED set of typed intents validated by a schema. The model may never produce a
 * decision (approve / decline / yes / no), start or stop customer outreach, or change a rule: those come only
 * from the owner's explicit words or a tapped button. Whatever the model returns runs through the same
 * deterministic service as everything else (grounding, the operating mode, approvals, the lock, the audit).
 *
 * It also turns an owner's instruction ("tell her I'm checking and will get back to her") into the message
 * the customer will read — always shown to the owner to confirm before anything is sent.
 */

type Interpreter = (text: string) => Promise<CommandIntent | undefined>;
type Drafter = (instruction: string, customer: string, lang: "en" | "he") => Promise<string | undefined>;
let interpreterForTests: Interpreter | null | undefined;
let drafterForTests: Drafter | null | undefined;
export function setOwnerModelForTests(m: { interpret?: Interpreter | null; draft?: Drafter | null } | undefined): void {
  interpreterForTests = m?.interpret;
  drafterForTests = m?.draft;
}

function client(): OpenAI | undefined {
  if (process.env.BARRY_REASONER !== "openai" || !process.env.OPENAI_API_KEY) return undefined;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 1, timeout: 20_000 });
}

/** The intents the model may choose (nothing that decides, starts outreach or changes rules). */
const ModelIntent = z.object({
  intent: z.enum(["needs_you", "working", "waiting", "money", "customer", "capabilities", "mode_query", "pause", "resume", "takeover", "giveback", "reply", "explain_approval", "unknown"]),
  subject: z.string().max(40).nullable(),
  money: z.enum(["totals", "stuck", "awaiting", "failed"]).nullable(),
  replyText: z.string().max(1000).nullable(),
});

const SCHEMA = {
  name: "owner_intent",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["intent", "subject", "money", "replyText"],
    properties: {
      intent: { type: "string", enum: ["needs_you", "working", "waiting", "money", "customer", "capabilities", "mode_query", "pause", "resume", "takeover", "giveback", "reply", "explain_approval", "unknown"] },
      subject: { type: ["string", "null"], description: "A customer's first name if the owner named one, else null." },
      money: { type: ["string", "null"], enum: ["totals", "stuck", "awaiting", "failed", null] },
      replyText: { type: ["string", "null"], description: "For intent=reply: what the owner wants said to the customer, else null." },
    },
  },
} as const;

const PROMPT = `You classify ONE message a business owner sent to BARRY (their AI operator) on WhatsApp, in English or Hebrew.
Choose the single intent that matches what the owner wants. Never invent a customer name.
- needs_you: what needs the owner / anything urgent / what should I deal with
- working: what BARRY is doing or handling now
- waiting: what we are waiting on (customers, approvals, payments, open items)
- money: revenue / payments; set money=stuck (money stuck or at risk), awaiting (awaiting payment), failed (failed payments) or totals
- customer: about one customer or the conversation in focus ("what's going on with her")
- capabilities: what BARRY can do
- mode_query: which mode BARRY is in / is it paused
- pause: stop/pause BARRY entirely; resume: let BARRY work again
- takeover: the owner wants to handle a customer conversation personally
- giveback: hand the conversation back to BARRY
- reply: the owner wants a message sent to a customer; replyText = what to say
- explain_approval: what a pending approval/request is for
- unknown: anything else, including approving/declining, greetings, or anything unclear.
Return JSON only.`;

export async function interpretWithModel(text: string): Promise<CommandIntent | undefined> {
  if (interpreterForTests !== undefined) return interpreterForTests ? interpreterForTests(text) : undefined;
  const c = client();
  if (!c) return undefined;
  try {
    const model = modelFor("composer");
    const completion = await createCompletion(c, { model, messages: [{ role: "system", content: PROMPT }, { role: "user", content: text.slice(0, 600) }], response_format: { type: "json_schema", json_schema: SCHEMA as never }, ...samplingParams(model, "composer", 0) }, "checker");
    const parsed = ModelIntent.safeParse(JSON.parse(completion.choices[0]?.message?.content ?? "{}"));
    if (!parsed.success) return undefined;
    const { intent, subject, money, replyText } = parsed.data;
    const named = subject && /^[\p{L}'-]{2,30}$/u.test(subject) ? { subject } : {};
    switch (intent) {
      case "needs_you":
      case "working":
      case "waiting":
      case "capabilities":
        return { kind: "query", topic: intent };
      case "money":
        return { kind: "query", topic: "money", ...(money && money !== "totals" ? { money } : {}) };
      case "customer":
        return { kind: "query", topic: "customer", ...named };
      case "mode_query":
        return { kind: "mode_query" };
      case "pause":
        return { kind: "mode_change", to: "paused" };
      case "resume":
        return { kind: "mode_change", to: "resumed" };
      case "takeover":
        return { kind: "conversation_takeover", ...named };
      case "giveback":
        return { kind: "conversation_giveback", ...named };
      case "reply":
        // Never sent as-is: the owner confirms the exact text first.
        return replyText?.trim() ? { kind: "conversation_reply", ...named, text: replyText.trim(), exact: false } : undefined;
      case "explain_approval":
        return { kind: "approval_explain", ...named };
      default:
        return undefined;
    }
  } catch (err) {
    console.warn("[barry:owner-command] model interpretation unavailable", err instanceof Error ? err.message.slice(0, 120) : err);
    return undefined;
  }
}

/**
 * The message the customer will read, from the owner's instruction ("that I'm checking and will get back to
 * her" → "I'm checking and will get back to you shortly."). Without a model, the owner's words are used as
 * they are. Either way the owner sees the exact text and confirms before it is sent.
 */
export async function draftCustomerReply(instruction: string, customer: string, lang: "en" | "he"): Promise<string> {
  const plain = instruction.replace(/^(?:that|ש)\s*/i, "").trim();
  if (drafterForTests !== undefined) return (drafterForTests ? await drafterForTests(instruction, customer, lang) : undefined) ?? plain;
  const c = client();
  if (!c) return plain;
  try {
    const model = modelFor("composer");
    const completion = await createCompletion(
      c,
      {
        model,
        messages: [
          { role: "system", content: `Rewrite the business owner's instruction as the exact WhatsApp message to send to their customer ${customer}, written by the owner in first person to the customer, in ${lang === "he" ? "Hebrew" : "English"}. Keep the owner's meaning only — add no promises, prices, dates or facts. One or two short sentences. Return only the message.` },
          { role: "user", content: instruction.slice(0, 800) },
        ],
        ...samplingParams(model, "composer", 0.2),
      },
      "composer"
    );
    const out = completion.choices[0]?.message?.content?.trim();
    return out && out.length <= 1000 ? out : plain;
  } catch {
    return plain;
  }
}
