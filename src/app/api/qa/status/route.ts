import type { NextRequest } from "next/server";
import { buildQaStatus } from "@/lib/qa/status";

/** Deployment status for testers (no secrets). Not served on Vercel Production. */
export async function GET(req: NextRequest) {
  if (process.env.VERCEL_ENV === "production") return new Response("Not found", { status: 404 });
  return Response.json(await buildQaStatus(req.nextUrl.searchParams.get("businessId") ?? undefined));
}
