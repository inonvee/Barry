import Link from "next/link";
import { requireFounder } from "@/lib/hq/guard";
import { getFleet } from "@/lib/hq/fleet";
import { founderHome } from "@/lib/founder/command-service";
import { hqShellData } from "@/lib/hq/shell-data";
import { HqShell } from "@/components/hq/HqShell";
import { FounderCommand } from "@/components/hq/FounderCommand";
import { EmptyState, FocusItem, FocusList, HeroBrief, Page, Section } from "@/components/ds/primitives";

const SUGGESTIONS = ["What do I need to know today?", "Which businesses need attention?", "What's going on with Rina?", "Which customers are costing us the most to serve?", "Which businesses aren't getting enough value from BARRY?", "What did BARRY notice across the fleet?", "Which businesses have broken integrations?", "What changed since yesterday?", "Handle what you safely can and leave me what needs approval."];

const STATUS = { high: "blocked", medium: "attention", low: "info" } as const;

/**
 * FOUNDER BARRY — one command field over the fleet (the Founder BARRY command service), and by default:
 * what needs you, what BARRY handled, what changed. Answers are grounded in HQ records; founder controls
 * need a confirmation; everything else becomes a proposal.
 */
export default async function HqAskPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireFounder();
  const { q } = await searchParams;
  const now = new Date();
  const fleet = await getFleet({ now });
  const home = await founderHome(now);
  return (
    <HqShell active="ask" data={hqShellData(fleet)}>
      <Page width="narrow">
        <HeroBrief eyebrow="Ask BARRY" title={home.brief.headline} lead="Ask anything about the fleet, or tell BARRY what to do. Answers come only from HQ records; pause / resume and safe mode ask you to confirm; anything bigger becomes a proposal." />
        <FounderCommand initial={(q ?? "").trim() || undefined} suggestions={SUGGESTIONS} />
        <div className="mt-6 flex flex-col gap-5">
          <Section title="What needs you" subtitle={home.brief.quiet ? undefined : "Only what the records say matters, most important first."}>
            {home.brief.quiet ? (
              <EmptyState title="Nothing needs you">{home.brief.headline}</EmptyState>
            ) : (
              <FocusList>
                {home.brief.items.map((i, n) => (
                  <FocusItem key={i.key} rank={n + 1} status={STATUS[i.severity]} title={i.title} why={i.why} move={i.move} href={i.href} />
                ))}
              </FocusList>
            )}
          </Section>
          <Section title="What BARRY handled" subtitle="Founder BARRY actions and proposals in the last 24 hours.">
            {home.handled.length === 0 ? <p className="text-[13px] text-[#667085]">Nothing yet today.</p> : (
              <ul className="flex flex-col gap-1.5 text-[13px] text-[#344054]">
                {home.handled.slice(0, 6).map((h, n) => <li key={n}>{h.what}</li>)}
              </ul>
            )}
          </Section>
          <Section title="What changed" subtitle="Last 24 hours, from founder audit and activity records.">
            {home.changed.length === 0 ? <p className="text-[13px] text-[#667085]">Nothing changed by the records.</p> : (
              <ul className="flex flex-col gap-1.5 text-[13px]">
                {home.changed.map((c, n) => <li key={n}><Link href={c.href} className="text-[#344054] hover:underline">{c.what}</Link></li>)}
              </ul>
            )}
          </Section>
        </div>
      </Page>
    </HqShell>
  );
}
