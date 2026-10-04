import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { OwnerModeError, ownerMode, ownerPause, ownerResume } from "@/lib/owner/mode";
import { ConversationBusyError } from "@/lib/state/lock";

/** The owner's view of BARRY's operating mode for their business, and their own pause / resume. */
export async function GET(req: NextRequest) {
  const g = ownerGraph(req, req.nextUrl.searchParams.get("businessId"));
  if ("error" in g) return g.error;
  try {
    return Response.json(await ownerMode(g.graph));
  } catch (err) {
    return ownerFailure("mode", err);
  }
}

const Body = z.object({ businessId: z.string().min(1), action: z.enum(["pause", "resume"]), reason: z.string().max(300).optional() });

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const g = ownerGraph(req, parsed.success ? parsed.data.businessId : null);
  if ("error" in g) return g.error;
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const by = "the owner (web)";
  try {
    const reason = parsed.data.reason?.trim() || undefined;
    return Response.json(parsed.data.action === "pause" ? await ownerPause(g.graph, by, reason) : await ownerResume(g.graph, by, reason));
  } catch (err) {
    if (err instanceof OwnerModeError) return Response.json({ error: err.message, code: err.code }, { status: 409 });
    if (err instanceof ConversationBusyError) return Response.json({ error: "Another change is being saved — try again in a moment." }, { status: 409 });
    return ownerFailure("mode", err);
  }
}
