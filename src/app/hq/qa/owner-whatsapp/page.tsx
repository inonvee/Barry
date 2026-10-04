import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireFounder } from "@/lib/hq/guard";
import { previewAcceptanceRefusal } from "@/lib/qa/preview-acceptance-guard";
import { OWA_STAGES } from "@/app/api/qa/owner-whatsapp/runner";
import { SequentialRunner } from "./SequentialRunner";

/**
 * TEMPORARY QA TOOLING — triggers the in-deployment Owner WhatsApp V1 acceptance (POST /api/qa/owner-whatsapp)
 * with the founder's HQ session. Protected exactly like /hq/qa: only a Preview on the Preview database with
 * dry-run sending (anywhere else, Production included, 404), and only for a signed-in founder. It holds no logic
 * and no credentials. Remove with src/app/api/qa/owner-whatsapp/.
 */
export default async function HqQaOwnerWhatsappPage() {
  await connection();
  if (previewAcceptanceRefusal()) notFound();
  await requireFounder();
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 16, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600 }}>Owner WhatsApp acceptance (temporary QA tool)</h1>
      <p style={{ fontSize: 13, opacity: 0.75 }}>Runs inside this Preview deployment against the Preview database with the live model and WhatsApp dry-run. A synthetic owner number is linked for the run and revoked after it; customers are synthetic (999…). Nothing is sent. Each stage is its own request (each fits Vercel&apos;s 300s limit); the run stops at the first failure or timeout. The test business is restored after every stage from a durable restore point — also after a timeout or if this tab is closed.</p>
      <SequentialRunner stages={[...OWA_STAGES]} />
    </main>
  );
}
