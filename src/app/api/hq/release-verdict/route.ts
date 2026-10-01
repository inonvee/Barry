import { NextResponse } from "next/server";
import { z } from "zod";
import { hqAuthError } from "@/lib/hq/auth";
import { recordWorkVerdict } from "@/lib/release/manifest";

const Body = z.object({ sha: z.string().min(7).max(64), verdict: z.enum(["passed", "blocked", "partial"]), note: z.string().max(1000).optional(), failedChecks: z.union([z.array(z.string()), z.string()]).optional() });

/** The founder records Work's live verdict for one SHA — the ONLY way a candidate becomes LIVE PASSED. */
export async function POST(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const type = req.headers.get("content-type") ?? "";
  const raw = type.includes("application/json") ? await req.json().catch(() => ({})) : Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "sha and verdict are required" }, { status: 400 });
  const failed = parsed.data.failedChecks === undefined ? undefined : Array.isArray(parsed.data.failedChecks) ? parsed.data.failedChecks : parsed.data.failedChecks.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const verdict = await recordWorkVerdict({ sha: parsed.data.sha.trim(), verdict: parsed.data.verdict, by: "founder", ...(parsed.data.note?.trim() ? { note: parsed.data.note.trim() } : {}), ...(failed?.length ? { failedChecks: failed } : {}) });
  if (type.includes("application/json")) return Response.json({ verdict });
  return NextResponse.redirect(new URL("/hq/releases", req.url), 303);
}
