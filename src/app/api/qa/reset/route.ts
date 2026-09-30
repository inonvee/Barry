import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerAuthError } from "@/lib/owner-auth";
import { qaEnabled } from "@/lib/qa/mode";
import { resetQaData } from "@/lib/qa/reset";

const Body = z.object({ businessId: z.string().min(1), confirm: z.literal(true) });

/** QA ONLY: delete this business's qa:-tagged records. Owner access required; explicit confirmation. */
export async function POST(req: NextRequest) {
  if (!qaEnabled()) return new Response("Not found", { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const denied = ownerAuthError(req, parsed.success ? parsed.data.businessId : undefined);
  if (denied) return denied;
  if (!parsed.success) return Response.json({ error: "businessId and confirm:true are required" }, { status: 400 });
  return Response.json({ result: await resetQaData(parsed.data.businessId) });
}
