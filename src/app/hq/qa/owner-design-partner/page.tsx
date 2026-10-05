import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireFounder } from "@/lib/hq/guard";
import { previewAcceptanceRefusal } from "@/lib/qa/preview-acceptance-guard";
import { ODP_STAGES } from "@/app/api/qa/owner-design-partner/runner";
import { SequentialRunner } from "../owner-whatsapp/SequentialRunner";

/**
 * TEMPORARY QA TOOLING — one click runs the Owner Design Partner readiness acceptance stage by stage (one POST to
 * /api/qa/owner-design-partner per stage). Protected exactly like the other /hq/qa pages: only a Preview on the
 * Preview database with dry-run customer / owner sending (anywhere else, Production included, 404), and only for a
 * signed-in founder. No logic and no credentials here. Remove with src/app/api/qa/owner-design-partner/.
 */
export default async function HqQaOwnerDesignPartnerPage() {
  await connection();
  if (previewAcceptanceRefusal()) notFound();
  await requireFounder();
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 16, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600 }}>Owner Design Partner readiness (temporary QA tool)</h1>
      <p style={{ fontSize: 13, opacity: 0.75 }}>Runs inside this Preview deployment against the Preview database with the live model. A synthetic owner links through the ONE shared WhatsApp number with a one-time code and uses Owner BARRY the way a Design Partner would (signed webhook, identity role routing). Every reply goes to a recording dry sender — nothing is sent; injected delivery failures never touch the network. Each stage restores the test business, revokes every synthetic identity, deletes its synthetic conversations and proves realGraphSendAttempts = 0.</p>
      <SequentialRunner stages={[...ODP_STAGES]} endpoint="/api/qa/owner-design-partner" label="Run Owner Design Partner acceptance" />
    </main>
  );
}
