import { requireFounder } from "@/lib/hq/guard";
import { getFleet } from "@/lib/hq/fleet";
import { currentRelease } from "@/lib/release/manifest";
import { hqShellData } from "@/lib/hq/shell-data";
import { HqShell } from "@/components/hq/HqShell";
import { ReleasePanel } from "@/components/hq/views";
import { Disclosure, HeroBrief, Page, Section, StatusPill, buttonPrimary, input } from "@/components/ds/primitives";

/** RELEASES — the build lane, apart from operating businesses: SHA, Preview, proof level, blockers, verdict, next live checks. */
export default async function HqReleasesPage() {
  await requireFounder();
  const now = new Date();
  const [fleet, release] = await Promise.all([getFleet({ now }), currentRelease()]);
  const m = release.manifest;
  return (
    <HqShell active="releases" data={hqShellData(fleet)}>
      <Page>
        <HeroBrief eyebrow="Releases" title={release.state === "LIVE_PASSED" ? "This build passed live." : release.nextProofRequired.length ? `${release.nextProofRequired.length} live check${release.nextProofRequired.length === 1 ? "" : "s"} before this build is proven.` : "No live checks outstanding."} lead="Deterministic proof is the build lane's; live proof is Work's. Only a recorded verdict makes a candidate LIVE PASSED. This surface never touches how a business runs." />
        <div className="flex flex-col gap-5">
          <Section title="Candidate">
            <ReleasePanel release={release} now={now} />
          </Section>
          <Section title="Next live checks" subtitle={`${m.liveProofRequired.length} checks, highest risk first.`}>
            <ol className="space-y-2">
              {m.liveProofRequired.map((c, i) => (
                <li key={c.id} className="flex flex-col gap-0.5 text-[13px]">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold tabular-nums text-[#98a2b3]">{i + 1}</span>
                    <StatusPill status={c.risk === "high" ? "blocked" : c.risk === "medium" ? "attention" : "neutral"}>{c.risk} risk</StatusPill>
                    <span className="font-medium text-[#101828]">{c.title}</span>
                  </span>
                  <span className="text-[12px] text-[#667085]">{c.where} · {c.why}</span>
                </li>
              ))}
            </ol>
            <div className="mt-3 flex flex-col gap-1">
              <Disclosure summary={`Implemented (${m.implemented.length}) · deterministically proven (${m.deterministicallyProven.length}) · locally proven (${m.locallyProven.length})`} muted>
                <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-[#475467]">
                  {m.implemented.map((x, i) => <li key={`i${i}`}>{x}</li>)}
                  {m.deterministicallyProven.map((x, i) => <li key={`d${i}`}>Deterministic: {x}</li>)}
                  {m.locallyProven.map((x, i) => <li key={`l${i}`}>Local: {x}</li>)}
                </ul>
              </Disclosure>
              <Disclosure summary={`Do not retest (${m.doNotRetest.length}) · known unverified (${m.knownUnverified.length}) · blockers (${m.knownBlockers.length})`} muted>
                <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-[#475467]">
                  {m.doNotRetest.map((x, i) => <li key={`n${i}`}>Do not retest: {x}</li>)}
                  {m.knownUnverified.map((x, i) => <li key={`u${i}`}>Unverified: {x}</li>)}
                  {m.knownBlockers.map((x, i) => <li key={`b${i}`}>Blocker: {x}</li>)}
                </ul>
              </Disclosure>
            </div>
          </Section>
          <Section title="Record Work's verdict" subtitle="The only way to LIVE PASSED. One record per SHA; the latest wins.">
            <form action="/api/hq/release-verdict" method="post" className="grid gap-2 sm:grid-cols-2">
              <label className="text-[12px] text-[#667085]">Build SHA<input name="sha" defaultValue={release.sha ?? ""} required className={`${input} mt-1 font-mono`} /></label>
              <label className="text-[12px] text-[#667085]">Verdict
                <select name="verdict" className={`${input} mt-1`}>
                  <option value="passed">passed</option>
                  <option value="partial">partial</option>
                  <option value="blocked">blocked</option>
                </select>
              </label>
              <label className="text-[12px] text-[#667085]">Failed check ids (optional)<input name="failedChecks" className={`${input} mt-1`} /></label>
              <label className="text-[12px] text-[#667085]">Note (optional)<input name="note" className={`${input} mt-1`} /></label>
              <div className="sm:col-span-2"><button className={`${buttonPrimary} w-full sm:w-auto`}>Record verdict</button></div>
            </form>
          </Section>
        </div>
      </Page>
    </HqShell>
  );
}
