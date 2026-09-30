import { z } from "zod";
import { hqAuthError } from "@/lib/hq/auth";
import { askHq } from "@/lib/hq/ask";

const Body = z.object({ question: z.string().min(1).max(1000) });

/** Ask HQ BARRY (read-only). */
export async function POST(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A question is required" }, { status: 400 });
  const out = await askHq(parsed.data.question);
  return Response.json({ answer: out.answer, source: out.source, reason: out.reason ?? null, links: out.links });
}
