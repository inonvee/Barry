import Link from "next/link";
import { requireFounder } from "@/lib/hq/guard";
import { askHq } from "@/lib/hq/ask";
import { getFleet } from "@/lib/hq/fleet";
import { hqShellData } from "@/lib/hq/shell-data";
import { HqShell } from "@/components/hq/HqShell";
import { HeroBrief, Page, Section, buttonPrimary, input } from "@/components/ds/primitives";

const SUGGESTIONS = ["Who needs me?", "Which business is degraded?", "What broke since the last build?", "Where is money stuck across the fleet?", "Which businesses are simulator-only?", "What is blocking Rina from going live?", "Which capability is failing most?", "What changed today?", "Show me unresolved incidents.", "Which business has the highest current operational risk?"];

/** Ask HQ BARRY — read-only founder operator over the fleet read models. */
export default async function HqAskPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireFounder();
  const { q } = await searchParams;
  const question = (q ?? "").trim();
  const fleet = await getFleet();
  const out = question ? await askHq(question, { fleet }) : null;
  return (
    <HqShell active="ask" data={hqShellData(fleet)}>
      <Page width="narrow">
        <HeroBrief eyebrow="Ask HQ BARRY" title={question || "What do you want to know about the fleet?"} lead="Answers come only from the fleet read models — status, incidents, controls, obligations, the release candidate. Read-only: nothing here acts." />
        <form method="get" className="flex flex-col gap-2 sm:flex-row">
          <input name="q" defaultValue={question} placeholder="Who needs me?" className={input} aria-label="Question" />
          <button className={`${buttonPrimary} sm:shrink-0`}>Ask</button>
        </form>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <Link key={s} href={`/hq/ask?q=${encodeURIComponent(s)}`} className="rounded-full bg-white px-2.5 py-1 text-[12px] text-[#344054] ring-1 ring-inset ring-[#e4e7ec] hover:bg-[#f9fafb]">
              {s}
            </Link>
          ))}
        </div>
        {out && (
          <div className="mt-5">
            <Section title={out.source === "model" ? "Answer" : "Fleet summary"} subtitle={out.source === "model" ? "From the model, verified against the briefing." : out.reason}>
              <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-[#344054]">{out.answer}</pre>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[12px]">
                {out.links.businesses.map((b) => (
                  <Link key={b.id} href={b.href} className="rounded-full bg-[#f2f4f7] px-2 py-0.5 hover:underline">{b.name}</Link>
                ))}
                {out.links.incidents.slice(0, 8).map((i) => (
                  <Link key={`${i.businessId}:${i.key}`} href={i.href} className="rounded-full bg-[#fffaeb] px-2 py-0.5 text-[#b54708] hover:underline">incident: {i.title}</Link>
                ))}
                <Link href="/hq/releases" className="rounded-full bg-[#eff8ff] px-2 py-0.5 text-[#175cd3] hover:underline">release candidate</Link>
              </div>
            </Section>
          </div>
        )}
      </Page>
    </HqShell>
  );
}
