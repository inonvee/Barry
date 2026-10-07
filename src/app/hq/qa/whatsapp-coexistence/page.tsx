import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireFounder } from "@/lib/hq/guard";
import { previewAcceptanceRefusal } from "@/lib/qa/preview-acceptance-guard";
import { COEX_ROUTING_ONLY, COEX_STAGES } from "@/app/api/qa/whatsapp-coexistence/runner";
import { SequentialRunner } from "../owner-whatsapp/SequentialRunner";

/**
 * TEMPORARY QA TOOLING — one click runs the WhatsApp coexistence + human takeover acceptance stage by stage (one POST
 * to /api/qa/whatsapp-coexistence per stage). Protected like the other /hq/qa pages: only a Preview on the Preview
 * database with dry-run customer sending (anywhere else, Production included, 404), and only for a signed-in founder.
 */
export default async function HqQaWhatsappCoexistencePage() {
  await connection();
  if (previewAcceptanceRefusal()) notFound();
  await requireFounder();
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 16, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600 }}>WhatsApp coexistence + human takeover (temporary QA tool)</h1>
      <p style={{ fontSize: 13, opacity: 0.75 }}>Runs inside this Preview deployment against the Preview database with the live model. Each stage registers two synthetic business customer numbers (999…), sends synthetic signed Meta webhooks — customer messages and WhatsApp Business app echoes — and proves that a team member&apos;s reply takes the conversation from BARRY before anything else leaves. Customer replies go to a recording stand-in; nothing is sent. Every stage removes its numbers, takeover records, conversations and identities, restores the test business and proves realGraphSendAttempts = 0.</p>
      <SequentialRunner stages={[...COEX_STAGES]} endpoint="/api/qa/whatsapp-coexistence" label="Run coexistence + takeover acceptance" />
      <hr style={{ margin: "28px 0", border: 0, borderTop: "1px solid #8884" }} />
      <h2 style={{ fontSize: 16, fontWeight: 600 }}>Routing only</h2>
      <p style={{ fontSize: 13, opacity: 0.75 }}>Runs only the routing stage (one POST with stages = [&quot;routing&quot;]) through the same deployed runner, with the same restore and cleanup, and still asserts realGraphSendAttempts = 0. Takeover, race, return and isolation are not run. Check B&apos;s evidence (initial holder before reasoning, its control log, final holder, final control log, open handoff after the turn) is shown below, pass or fail.</p>
      <SequentialRunner stages={[...COEX_ROUTING_ONLY]} endpoint="/api/qa/whatsapp-coexistence" label="Run routing only" evidenceCheck="B: " />
    </main>
  );
}
