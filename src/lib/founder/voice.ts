import OpenAI from "openai";
import { createCompletion, modelFor, samplingParams } from "@/lib/reasoner/model-config";

/**
 * FOUNDER BARRY — CONVERSATION LAYER. The runtime decides what is TRUE; this layer only decides how to SAY it.
 *
 * The command service produces a grounded reply (deterministic text + structured facts). This module wraps it
 * in an immutable ENVELOPE — the grounded text, the items, what was actually done (and verified), what was not
 * done, whether the founder must confirm, whether anything was sent, the proposals — and lets a composer turn
 * that envelope into natural language in the founder's own language (English, Hebrew, mixed).
 *
 * The composer may only rephrase. Its output is CHECKED against the envelope before it is shown: every number
 * must be one the envelope states; no business outside the envelope may be named; no action may be claimed
 * unless the envelope says it was executed and verified; "nothing was sent" can't become "I sent"; a required
 * confirmation must still be asked for. Any failure — or no composer at all — falls back to the grounded text.
 * Nothing here executes, decides, or grants authority.
 */

export type FounderEnvelope = {
  question: string;
  language: "en" | "he";
  intent: string;
  status: string;
  /** The deterministic, grounded reply — the truth this layer may rephrase, never extend. */
  grounded: string;
  items: { title: string; detail?: string }[];
  /** Actions that were EXECUTED and VERIFIED this turn (empty unless status is executed). */
  done: string[];
  /** What was deliberately not done / why the command stopped. */
  notDone: string[];
  /** The exact control the founder must confirm, if any. */
  confirmationRequired: string | null;
  /** True whenever no message, payment or external effect left BARRY this turn. */
  nothingSent: true;
  proposals: string[];
  businessesInScope: string[];
  followUps: string[];
};

export type FounderComposer = (envelope: FounderEnvelope) => Promise<string | undefined>;
export type VoiceResult = { text: string; source: "composer" | "grounded"; reason?: string };

const HEBREW = /[֐-׿]/;
export const languageOf = (text: string): "en" | "he" => (HEBREW.test(text) ? "he" : "en");

/** Numbers as values: "5,000" is 5000 (thousands separator), "0.02938" stays a decimal — so "5,000" can't pass as "5". */
const numbersIn = (s: string): string[] => (s.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
const ACTION_CLAIM = /\b(I(?:'ve| have)?|we(?:'ve| have)?)\s+(?:just\s+|now\s+|already\s+)?(paused|resumed|unpaused|put|took|turned|switched|enabled|disabled|sent|messaged|contacted|texted|emailed|charged|refunded|approved|declined|activated|deployed|rolled out|changed|updated|cancelled|canceled)\b|\b(it'?s|that'?s|all)\s+done\b|השהיתי|חידשתי|הפעלתי|כיביתי|שלחתי|אישרתי|דחיתי|שיניתי|ביטלתי|חייבתי|פרסתי/i;
const SENT_CLAIM = /\b(I(?:'ve| have)?|we(?:'ve| have)?|BARRY(?: has)?)\s+(?:just\s+|already\s+)?(sent|messaged|contacted|texted|emailed|reached out|followed up|notified)\b|שלחתי|פניתי ל|יצרתי קשר/i;
const DEPLOY_CLAIM = /\b(rolled out|deployed|is live|went live|activated)\b|פרסתי|עלה לאוויר/i;
const CONFIRM_ASK = /\bconfirm\b|\bconfirmation\b|לאשר|אישור|תאשר/i;

/** Why a composed reply can't be shown (undefined = it may be shown). Pure. */
export function checkComposed(text: string, env: FounderEnvelope, fleetNames: string[] = []): string | undefined {
  const t = text.trim();
  if (!t) return "empty";
  if (t.length > Math.max(1200, env.grounded.length * 2 + 400)) return "too long";
  const allowed = new Set(numbersIn(JSON.stringify(env)));
  const stray = numbersIn(t).filter((n) => !allowed.has(n) && !allowed.has(String(Number(n))));
  if (stray.length) return `figures not in the grounded reply: ${[...new Set(stray)].join(", ")}`;
  const envText = JSON.stringify(env).toLowerCase();
  const foreign = fleetNames.filter((n) => t.toLowerCase().includes(n.toLowerCase()) && !envText.includes(n.toLowerCase()));
  if (foreign.length) return `names a business that isn't part of this answer: ${foreign[0]}`;
  if (SENT_CLAIM.test(t)) return "claims something was sent";
  const claim = t.match(ACTION_CLAIM);
  if (claim) {
    // Even on an executed turn, only the action that WAS done may be claimed.
    const verb = (claim[2] ?? claim[0]).toLowerCase().slice(0, 5);
    const doneText = env.done.join(" ").toLowerCase();
    if (env.status !== "executed" || !env.done.length || (/[a-z]/.test(verb) && !doneText.includes(verb))) return "claims an action that was not executed";
  }
  if (env.status === "proposed" && DEPLOY_CLAIM.test(t)) return "claims a proposal was applied";
  if (env.confirmationRequired && !CONFIRM_ASK.test(t)) return "drops the confirmation the founder must give";
  return undefined;
}

/** Turn the envelope into the reply shown: composer output if it passes the checks, else the grounded text. */
export async function voice(env: FounderEnvelope, composer: FounderComposer | undefined, fleetNames: string[] = []): Promise<VoiceResult> {
  if (!composer) return { text: env.grounded, source: "grounded" };
  let out: string | undefined;
  try {
    out = await composer(env);
  } catch {
    return { text: env.grounded, source: "grounded", reason: "composer unavailable" };
  }
  if (!out?.trim()) return { text: env.grounded, source: "grounded", reason: "composer returned nothing" };
  const problem = checkComposed(out, env, fleetNames);
  if (problem) return { text: env.grounded, source: "grounded", reason: `composer reply rejected: ${problem}` };
  return { text: out.trim(), source: "composer" };
}

const PROMPT = `You are Founder BARRY — the founder's chief of staff over a fleet of businesses BARRY runs. You speak like a sharp, warm, concise operator: natural sentences, no headers, no bullet dumps unless a list genuinely helps, no restating the question, no internal ids unless useful.
You receive an ENVELOPE. "grounded" is the verified truth of this turn. Rephrase it for the founder. Rules:
- Use ONLY facts in the envelope. Keep every number exactly as written. Never add a business, customer, amount, count, status or outcome.
- "done" lists the only actions actually executed and verified. Never claim any other action. If "done" is empty, you did nothing.
- "nothingSent" is true: never say or imply that a message, payment or follow-up was sent to anyone.
- If "confirmationRequired" is set, end by asking the founder to confirm exactly that — it has NOT happened yet.
- A proposal is only prepared, never applied.
- Keep what the founder still has to decide or what blocked you ("notDone") — never hide a blocker.
- Reply in the founder's language ("language": "he" = Hebrew, keep business names as written; "en" = English). Short by default; longer only when the facts need it.
- You may end with one natural next step drawn from "followUps".
Reply with the message text only.`;

/** The model composer (only when a model is configured). */
export function modelFounderComposer(): FounderComposer | undefined {
  if (process.env.BARRY_REASONER !== "openai" || !process.env.OPENAI_API_KEY) return undefined;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 1 });
  const model = modelFor("composer");
  return async (env) => {
    const completion = await createCompletion(client, {
      model,
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: JSON.stringify(env) },
      ],
      ...samplingParams(model, "composer", 0.3),
    });
    return completion.choices[0]?.message?.content ?? undefined;
  };
}
