import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hqAuthError } from "@/lib/hq/auth";
import { executeFounderCommand, founderHome, listFounderCommands } from "@/lib/founder/command-service";
import { modelFounderInterpreter } from "@/lib/founder/model-interpreter";

const Body = z.object({
  text: z.string().max(1000).optional(),
  key: z.string().min(8).max(120).optional(),
  confirmKey: z.string().min(1).max(120).optional(),
  context: z.object({ businessId: z.string().max(120).optional() }).optional(),
});

/**
 * FOUNDER BARRY — one command service over the fleet. Founder session or founder bearer token only.
 * POST { text, key } → answer | clarification | confirmation | proposal; POST { confirmKey } executes a
 * pending founder control exactly once. GET → the default view and recent command traces.
 */
export async function POST(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || (!parsed.data.text?.trim() && !parsed.data.confirmKey)) return Response.json({ error: "Say what you want, or confirm a pending action." }, { status: 400 });
  const via = /^Bearer\s+/i.test(req.headers.get("authorization") ?? "") ? "token" : "session";
  const out = await executeFounderCommand({
    actor: { kind: "founder", via },
    key: parsed.data.key ?? `fc_${randomUUID()}`,
    text: parsed.data.text,
    confirmKey: parsed.data.confirmKey,
    context: parsed.data.context,
    interpreter: modelFounderInterpreter(),
  });
  return Response.json(out);
}

export async function GET(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const [home, commands] = await Promise.all([founderHome(), listFounderCommands(30)]);
  return Response.json({ home, commands });
}
