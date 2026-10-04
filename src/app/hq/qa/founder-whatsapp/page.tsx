import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireFounder } from "@/lib/hq/guard";
import { previewAcceptanceRefusal } from "@/lib/qa/preview-acceptance-guard";
import { FWA_STAGES } from "@/app/api/qa/founder-whatsapp/runner";
import { SequentialRunner } from "../owner-whatsapp/SequentialRunner";

/**
 * TEMPORARY QA TOOLING — one click runs the Founder WhatsApp V1 acceptance stage by stage (one POST to
 * /api/qa/founder-whatsapp per stage). Protected exactly like /hq/qa and /hq/qa/owner-whatsapp: only a Preview on the
 * Preview database with dry-run sending (anywhere else, Production included, 404), and only for a signed-in founder.
 * No logic and no credentials here. Remove with src/app/api/qa/founder-whatsapp/.
 */
export default async function HqQaFounderWhatsappPage() {
  await connection();
  if (previewAcceptanceRefusal()) notFound();
  await requireFounder();
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 16, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600 }}>Founder WhatsApp acceptance (temporary QA tool)</h1>
      <p style={{ fontSize: 13, opacity: 0.75 }}>Runs inside this Preview deployment against the Preview database with the live model and WhatsApp dry-run. A synthetic founder number is linked with an HQ-issued code for each stage and revoked after it; owner and customer numbers are synthetic (999…). Founder controls touch only the test business; every lever is restored from a durable restore point after every stage — also after a timeout or if this tab is closed. Nothing is sent.</p>
      <SequentialRunner stages={[...FWA_STAGES]} endpoint="/api/qa/founder-whatsapp" label="Run full Founder WhatsApp acceptance" />
      <hr style={{ margin: "28px 0", border: 0, borderTop: "1px solid #8884" }} />
      <h2 style={{ fontSize: 16, fontWeight: 600 }}>Focused shared-line acceptance</h2>
      <p style={{ fontSize: 13, opacity: 0.75 }}>Runs only the shared_line stage, including dual-role precedence, synthetic founder/owner cleanup, restore, and zero-real-Graph-send proof.</p>
      <SequentialRunner stages={["shared_line"]} endpoint="/api/qa/founder-whatsapp" label="Run shared_line only" />
    </main>
  );
}
