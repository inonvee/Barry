import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireFounder } from "@/lib/hq/guard";
import { previewAcceptanceRefusal } from "@/lib/qa/preview-acceptance-guard";
import { QaRunner } from "./QaRunner";

/**
 * TEMPORARY QA TOOLING — a plain page that triggers the in-deployment Preview acceptance (POST /api/qa/acceptance)
 * with the founder's HQ session. It holds no logic and no credentials: the browser only ever sends the session
 * cookie it already has. Same guards as the API: only a Preview on the Preview database with dry-run sending —
 * anywhere else (Production included) this page does not exist (404). Remove with src/app/api/qa/acceptance/.
 */
export default async function HqQaPage() {
  await connection();
  if (previewAcceptanceRefusal()) notFound();
  await requireFounder();
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 16, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600 }}>Preview acceptance (temporary QA tool)</h1>
      <p style={{ fontSize: 13, opacity: 0.75 }}>Runs inside this Preview deployment against the Preview database with WhatsApp dry-run. Synthetic customers only. The test business&apos;s mode is restored after each run.</p>
      <QaRunner />
    </main>
  );
}
