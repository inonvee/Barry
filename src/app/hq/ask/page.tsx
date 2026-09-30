import Link from "next/link";
import { requireFounder } from "@/lib/hq/guard";
import { askHq } from "@/lib/hq/ask";
import { Card, HqHeader } from "@/components/hq/ui";

const SUGGESTIONS = ["Who needs me?", "Which business is degraded?", "What broke since the last build?", "Where is money stuck across the fleet?", "Which businesses are simulator-only?", "What is blocking Rina from going live?", "Which capability is failing most?", "What changed today?", "Show me unresolved incidents.", "Which business has the highest current operational risk?"];

/** Ask HQ BARRY — read-only founder operator over the fleet read models. */
export default async function HqAskPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireFounder();
  const { q } = await searchParams;
  const question = (q ?? "").trim();
  const out = question ? await askHq(question) : null;
  return (
    <>
      <HqHeader crumbs={[{ label: "Ask HQ BARRY" }]} />
      <main className="mx-auto max-w-4xl space-y-4 px-4 py-6">
        <div>
          <h1 className="text-lg font-semibold">Ask HQ BARRY</h1>
          <p className="text-xs text-neutral-500">Answers come only from the fleet read models (status, incidents, controls, obligations, the release candidate). Read-only: nothing here acts.</p>
        </div>
        <form method="get" className="flex gap-2">
          <input name="q" defaultValue={question} placeholder="Who needs me?" className="min-w-0 flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm" />
          <button className="rounded-lg bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 px-4 py-2 text-sm font-medium">Ask</button>
        </form>
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <Link key={s} href={`/hq/ask?q=${encodeURIComponent(s)}`} className="rounded-full border border-neutral-200 dark:border-neutral-800 px-2.5 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800">
              {s}
            </Link>
          ))}
        </div>
        {out && (
          <Card title={out.source === "model" ? "Answer (model, verified against the briefing)" : `Fleet summary${out.reason ? ` — ${out.reason}` : ""}`}>
            <pre className="whitespace-pre-wrap text-sm">{out.answer}</pre>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
              {out.links.businesses.map((b) => (
                <Link key={b.id} href={b.href} className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 hover:underline">{b.name}</Link>
              ))}
              {out.links.incidents.slice(0, 8).map((i) => (
                <Link key={`${i.businessId}:${i.key}`} href={i.href} className="rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 px-2 py-0.5 hover:underline">incident: {i.title}</Link>
              ))}
              <Link href={out.links.release.href} className="rounded-full bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300 px-2 py-0.5 hover:underline">release candidate</Link>
            </div>
          </Card>
        )}
      </main>
    </>
  );
}
