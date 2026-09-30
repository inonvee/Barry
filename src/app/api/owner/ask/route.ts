import type { NextRequest } from "next/server";
import { z } from "zod";
import { ownerFailure, ownerGraph } from "@/lib/owner/http";
import { askOwnerBarry } from "@/lib/owner/ask";

const Body = z.object({ businessId: z.string().min(1), question: z.string().min(1).max(1000) });

/** Owner Barry: read-only questions about this business, answered from its records. */
export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const g = ownerGraph(req, parsed.success ? parsed.data.businessId : undefined);
  if ("error" in g) return g.error;
  if (!parsed.success) return Response.json({ error: "Ask a question (up to 1000 characters)" }, { status: 400 });
  try {
    const { answer, source, reason, links } = await askOwnerBarry(g.graph, parsed.data.question);
    return Response.json({ answer, source, links, ...(reason ? { note: reason } : {}) });
  } catch (err) {
    return ownerFailure("ask", err);
  }
}
