import type OpenAI from "openai";

/**
 * Which model does which job. Understanding (customer conversation ->
 * BARRY IR) is where a mistake loses a sale or picks the wrong operation,
 * so it gets its own, explicitly chosen model. Composition (verified
 * outcome -> wording) is lower-risk and can later use a different one.
 *
 *   BARRY_REASONER_MODEL            understanding            (fallback: BARRY_MODEL)
 *   BARRY_REASONER_REASONING_EFFORT none|minimal|low|medium|high (reasoning models only)
 *   BARRY_COMPOSER_MODEL            customer reply wording   (fallback: reasoner model)
 *   BARRY_COMPOSER_REASONING_EFFORT
 *   BARRY_LEARNER_MODEL             Learn Business extraction (fallback: reasoner model)
 *
 * The code default stays the previous baseline so an environment that sets
 * nothing behaves exactly as before; the launch configuration is chosen
 * explicitly (see docs) — never silently by a code change.
 */

export type ModelRole = "reasoner" | "composer" | "learner";

export const BASELINE_MODEL = "gpt-4o-mini";

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high"]);

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function modelFor(role: ModelRole): string {
  const reasoner = env("BARRY_REASONER_MODEL") ?? env("BARRY_MODEL") ?? BASELINE_MODEL;
  if (role === "reasoner") return reasoner;
  if (role === "composer") return env("BARRY_COMPOSER_MODEL") ?? reasoner;
  return env("BARRY_LEARNER_MODEL") ?? reasoner;
}

export function reasoningEffortFor(role: ModelRole): string | undefined {
  const value = env(role === "composer" ? "BARRY_COMPOSER_REASONING_EFFORT" : "BARRY_REASONER_REASONING_EFFORT");
  if (!value) return undefined;
  if (!EFFORTS.has(value)) throw new Error(`Invalid reasoning effort "${value}" for ${role}`);
  return value;
}

/** GPT-5-family and o-series models take reasoning effort and ignore/refuse sampling temperature. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

/** Sampling/reasoning parameters appropriate to the model, never both kinds. */
export function samplingParams(
  model: string,
  role: ModelRole,
  temperature: number,
  effortOverride?: string
): { temperature?: number; reasoning_effort?: OpenAI.ReasoningEffort } {
  if (isReasoningModel(model)) {
    if (effortOverride !== undefined && !EFFORTS.has(effortOverride)) throw new Error(`Invalid reasoning effort "${effortOverride}"`);
    const effort = effortOverride ?? reasoningEffortFor(role);
    return effort ? { reasoning_effort: effort as OpenAI.ReasoningEffort } : {};
  }
  return { temperature };
}

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

/**
 * One chat completion. If the model rejects a sampling/reasoning parameter
 * (models differ; a new model id should not take BARRY down), retry ONCE
 * without those parameters — the request itself is otherwise unchanged.
 */
export async function createCompletion(client: OpenAI, params: ChatParams): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  try {
    return await client.chat.completions.create(params);
  } catch (err) {
    const status = (err as { status?: number }).status;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 400 && /temperature|reasoning_effort|reasoning effort/i.test(message) && ("temperature" in params || "reasoning_effort" in params)) {
      const rest: ChatParams = { ...params };
      delete rest.temperature;
      delete rest.reasoning_effort;
      return client.chat.completions.create(rest);
    }
    throw err;
  }
}
