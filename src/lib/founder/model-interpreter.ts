import OpenAI from "openai";
import { createCompletion, modelFor, samplingParams } from "@/lib/reasoner/model-config";
import type { FounderInterpreter } from "./command";

/**
 * The optional model interpreter for Founder BARRY: it only classifies the founder's words into the
 * closed intent set (and names business hints). Its JSON is schema-checked by `intentFromModel`; it never
 * sees secrets, never answers, and nothing it returns carries authority. Absent without a configured model.
 */
const PROMPT = `Classify the founder's message for BARRY HQ. Reply with JSON only:
{"family": one of fleet_read|business_inspect|commercial_read|value_read|incident_read|initiative_read|initiative_scan|release_read|founder_action|proposal|handle_safe|unsupported,
 "topic": optional (brief|attention|changed|why|incidents|options|cost_to_serve|plans|integrations),
 "action": optional (pause_business|resume_business|safe_mode_on|safe_mode_off),
 "kind": optional (rollout|runtime|capability|configuration),
 "businesses": optional array of business names exactly as the founder wrote them}
Never invent a business. Anything about SQL, environment variables, secrets, deploying code, or deciding for an owner is "unsupported".`;

export function modelFounderInterpreter(): FounderInterpreter | undefined {
  if (process.env.BARRY_REASONER !== "openai" || !process.env.OPENAI_API_KEY) return undefined;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 1 });
  const model = modelFor("composer");
  return async (text: string) => {
    const completion = await createCompletion(client, {
      model,
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: text.slice(0, 1000) },
      ],
      response_format: { type: "json_object" },
      ...samplingParams(model, "composer", 0),
    });
    return JSON.parse(completion.choices[0]?.message?.content ?? "null");
  };
}
