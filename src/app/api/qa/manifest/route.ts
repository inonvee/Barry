import { currentRelease } from "@/lib/release/manifest";

/** The acceptance manifest + release state for this build (no secrets). Not served on Vercel Production. */
export async function GET() {
  if (process.env.VERCEL_ENV === "production") return new Response("Not found", { status: 404 });
  const r = await currentRelease();
  return Response.json({ state: r.state, sha: r.sha, preview: r.preview, environment: r.environment, manifest: r.manifest, verdict: r.verdict, gates: r.gates, nextProofRequired: r.nextProofRequired });
}
