import Link from "next/link";
import { requireFounder } from "@/lib/hq/guard";
import { getFleet, type BusinessStatus } from "@/lib/hq/fleet";
import { currentRelease } from "@/lib/release/manifest";
import { Badge, Card, HqHeader, Kv, type Tone } from "@/components/hq/ui";

const money = (m: Record<string, number>) => Object.entries(m).filter(([, v]) => v > 0).map(([c, v]) => `${v.toFixed(0)} ${c}`).join(" + ") || "—";
const when = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) : "—");
const HEALTH: Record<BusinessStatus["health"], { tone: Tone; label: string }> = { healthy: { tone: "good", label: "healthy" }, attention: { tone: "warn", label: "attention" }, unhealthy: { tone: "bad", label: "unhealthy" } };
const STAGE: Record<BusinessStatus["stage"], string> = { simulator_only: "simulator only", supervised: "supervised", live_ready: "live-ready" };
const STATE_TONE: Record<string, Tone> = { LIVE_PASSED: "good", BLOCKED: "bad", LIVE_PROOF_REQUIRED: "warn", LOCALLY_PROVEN: "info", DETERMINISTICALLY_PROVEN: "info", IMPLEMENTED: "neutral" };

/**
 * BARRY HQ — the founder's fleet view. Exceptions first: who needs me, what broke, what changed, where
 * money is blocked, which businesses are not ready. Then one status row per business and the release
 * cockpit for the current candidate build.
 */
export default async function HqOverviewPage() {
  await requireFounder();
  const [fleet, release] = await Promise.all([getFleet(), currentRelease()]);
  const s = fleet.summary;

  return (
    <>
      <HqHeader crumbs={[]} />
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">Fleet</h1>
            <p className="text-xs text-neutral-500">
              {s.healthy} of {s.businesses} businesses healthy · build {fleet.build.commit ? fleet.build.commit.slice(0, 7) : "local"} · {fleet.build.environment} · {when(fleet.at)}
            </p>
          </div>
          <Link href="/hq/ask" className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
            Ask HQ BARRY ›
          </Link>
        </div>

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <Card title="Who needs me?" right={<Badge tone={s.needFounder.length ? "bad" : "good"}>{s.needFounder.length}</Badge>}>
            {s.needFounder.length === 0 ? <p className="text-sm text-neutral-500">Nobody right now.</p> : (
              <ul className="space-y-1 text-sm">
                {s.needFounder.map((x) => (
                  <li key={x.id}>
                    <Link href={`/hq/${encodeURIComponent(x.id)}`} className="font-medium hover:underline">{x.name}</Link> <span className="text-neutral-500">— {x.why}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="What broke?" right={<Badge tone={s.broke.some((b) => b.incident.severity === "high") ? "bad" : s.broke.length ? "warn" : "good"}>{s.broke.length}</Badge>}>
            {s.broke.length === 0 ? <p className="text-sm text-neutral-500">No open incidents above low severity.</p> : (
              <ul className="space-y-1 text-sm">
                {s.broke.slice(0, 6).map((x) => (
                  <li key={`${x.id}:${x.incident.key}`}>
                    <Badge tone={x.incident.severity === "high" ? "bad" : "warn"}>{x.incident.severity}</Badge>{" "}
                    <Link href={`/hq/${encodeURIComponent(x.id)}#incidents`} className="hover:underline">{x.name}: {x.incident.title}</Link>
                    {x.incident.status !== "current" && <span className="text-xs text-neutral-500"> · {x.incident.status}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="What changed (24h)?" right={<Badge>{s.changed.length}</Badge>}>
            {s.changed.length === 0 ? <p className="text-sm text-neutral-500">Nothing in the last 24 hours.</p> : (
              <ul className="space-y-1 text-sm">
                {s.changed.slice(0, 6).map((x, i) => (
                  <li key={i}>
                    <Link href={`/hq/${encodeURIComponent(x.id)}`} className="font-medium hover:underline">{x.name}</Link> <span className="text-neutral-500">— {x.what}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Where is money blocked?" right={<Badge tone={s.moneyBlocked.length ? "warn" : "good"}>{s.moneyBlocked.length}</Badge>}>
            {s.moneyBlocked.length === 0 ? <p className="text-sm text-neutral-500">No money waits on an owner or is at risk.</p> : (
              <ul className="space-y-1 text-sm">
                {s.moneyBlocked.map((x) => (
                  <li key={x.id}>
                    <Link href={`/hq/${encodeURIComponent(x.id)}`} className="font-medium hover:underline">{x.name}</Link> <span className="text-neutral-500">— {money(x.stuckWithOwner)} with the owner · {money(x.atRisk)} at risk</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Not ready" right={<Badge tone={s.notReady.length ? "warn" : "good"}>{s.notReady.length}</Badge>}>
            {s.notReady.length === 0 ? <p className="text-sm text-neutral-500">Every business is at least ready for a supervised pilot.</p> : (
              <ul className="space-y-1 text-sm">
                {s.notReady.map((x) => (
                  <li key={x.id}>
                    <Link href={`/hq/${encodeURIComponent(x.id)}#launch`} className="font-medium hover:underline">{x.name}</Link> <span className="text-neutral-500">— {x.level.replace(/_/g, " ").toLowerCase()}{x.blocker ? `: ${x.blocker}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Release candidate" right={<Badge tone={STATE_TONE[release.state] ?? "neutral"}>{release.state.replace(/_/g, " ")}</Badge>}>
            <Kv k="SHA" v={<span className="font-mono text-xs">{release.sha ?? "local build"}</span>} />
            <Kv k="Preview" v={release.preview ? <a className="break-all text-xs hover:underline" href={release.preview}>{release.preview}</a> : "—"} />
            <Kv k="Live checks left" v={String(release.nextProofRequired.length)} />
            <Kv k="Last verdict" v={release.verdict ? `${release.verdict.verdict} · ${release.verdict.sha.slice(0, 7)}` : "none"} />
            <a href="#release" className="mt-1 inline-block text-xs text-neutral-500 hover:underline">Cockpit ↓</a>
          </Card>
        </div>

        <Card title="Businesses">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="py-1 pr-3">Business</th>
                  <th className="py-1 pr-3">Health</th>
                  <th className="py-1 pr-3">Stage · mode</th>
                  <th className="py-1 pr-3">Model</th>
                  <th className="py-1 pr-3">Storage</th>
                  <th className="py-1 pr-3">WhatsApp</th>
                  <th className="py-1 pr-3">Payments</th>
                  <th className="py-1 pr-3">Readiness</th>
                  <th className="py-1 pr-3">Needs · held</th>
                  <th className="py-1 pr-3">Incidents</th>
                  <th className="py-1 pr-3">Watching</th>
                  <th className="py-1 pr-3">Money w/ owner</th>
                  <th className="py-1 pr-3">Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {fleet.businesses.map((b) => (
                  <tr key={b.id}>
                    <td className="py-1.5 pr-3">
                      <Link href={`/hq/${encodeURIComponent(b.id)}`} className="font-medium hover:underline">{b.name}</Link>
                      <div className="text-xs text-neutral-500">{b.id}</div>
                    </td>
                    <td className="py-1.5 pr-3"><Badge tone={HEALTH[b.health].tone}>{HEALTH[b.health].label}</Badge></td>
                    <td className="py-1.5 pr-3">
                      {STAGE[b.stage]} · <span className="uppercase text-xs">{b.controls.mode}</span>
                      {b.controls.pauseConsequentialWrites && <Badge tone="bad">writes paused</Badge>}
                      {b.controls.approvalRequiredForAll && <Badge tone="warn">human-only</Badge>}
                    </td>
                    <td className="py-1.5 pr-3"><Badge tone={b.model.status === "unavailable" ? "bad" : b.model.status === "degraded" ? "warn" : b.model.mode === "live_model" ? "good" : "info"}>{b.model.mode === "live_model" ? "live" : "simulator"} · {b.model.status.replace(/_/g, " ")}</Badge></td>
                    <td className="py-1.5 pr-3">{b.storage}</td>
                    <td className="py-1.5 pr-3">{b.channel.whatsapp.replace(/_/g, " ")}</td>
                    <td className="py-1.5 pr-3">{b.providers.payments}</td>
                    <td className="py-1.5 pr-3"><Badge tone={b.readiness.level === "READY_FOR_CUSTOMER_TRAFFIC" ? "good" : b.readiness.level === "NOT_READY" ? "bad" : "warn"}>{b.readiness.label}</Badge></td>
                    <td className="py-1.5 pr-3">{b.interventions} · {b.approvalsHeld}</td>
                    <td className="py-1.5 pr-3">
                      {b.incidents.high ? <Badge tone="bad">{b.incidents.high} high</Badge> : null} {b.incidents.medium ? <Badge tone="warn">{b.incidents.medium} med</Badge> : null} {b.incidents.low ? <Badge>{b.incidents.low} low</Badge> : null}
                      {!b.incidents.high && !b.incidents.medium && !b.incidents.low ? <span className="text-neutral-400">none</span> : null}
                    </td>
                    <td className="py-1.5 pr-3">{b.obligations.open} ({b.obligations.needsOwner} need owner)</td>
                    <td className="py-1.5 pr-3">{money(b.money.stuckWithOwner)}</td>
                    <td className="py-1.5 pr-3 text-xs">{when(b.conversations.latestActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Release cockpit">
          <div id="release" className="grid gap-4 lg:grid-cols-2">
            <div>
              <Kv k="Candidate" v={release.manifest.candidate} />
              <Kv k="State" v={<Badge tone={STATE_TONE[release.state] ?? "neutral"}>{release.state.replace(/_/g, " ")}</Badge>} />
              <Kv k="SHA" v={<span className="font-mono text-xs">{release.sha ?? "local build"}</span>} />
              <Kv k="Environment" v={release.environment} />
              <Kv k="Preview" v={release.preview ?? "—"} />
              <ul className="mt-2 space-y-1 text-sm">
                {release.gates.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={g.status === "pass" ? "good" : g.status === "fail" ? "bad" : "neutral"}>{g.status}</Badge>
                    <span className="font-medium">{g.label}</span>
                    <span className="text-xs text-neutral-500">{g.detail}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-neutral-500">Last Work verdict: {release.verdict ? `${release.verdict.verdict} on ${release.verdict.sha.slice(0, 7)} at ${when(release.verdict.at)}${release.verdict.note ? ` — ${release.verdict.note}` : ""}` : "none recorded"}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Next proof required ({release.manifest.liveProofRequired.length})</p>
              <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">
                {release.manifest.liveProofRequired.map((c) => (
                  <li key={c.id}>
                    <span className="font-medium">{c.title}</span> <span className="text-xs text-neutral-500">· {c.where} · {c.risk}</span>
                  </li>
                ))}
              </ol>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-neutral-500">Do not retest · known unverified · domains changed</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                  {release.manifest.doNotRetest.map((x, i) => <li key={`d${i}`}>Do not retest: {x}</li>)}
                  {release.manifest.knownUnverified.map((x, i) => <li key={`u${i}`}>Unverified: {x}</li>)}
                  {release.manifest.domainsChanged.map((x, i) => <li key={`c${i}`}>Changed: {x}</li>)}
                </ul>
              </details>
              <form action="/api/hq/release-verdict" method="post" className="mt-3 space-y-2 rounded-lg border border-neutral-200 dark:border-neutral-800 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Record Work&apos;s verdict (the only way to LIVE PASSED)</p>
                <input name="sha" defaultValue={release.sha ?? ""} placeholder="build sha" required className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 font-mono text-xs" />
                <select name="verdict" className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm">
                  <option value="passed">passed</option>
                  <option value="partial">partial</option>
                  <option value="blocked">blocked</option>
                </select>
                <input name="failedChecks" placeholder="failed check ids, comma-separated (optional)" className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-xs" />
                <input name="note" placeholder="note (optional)" className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-xs" />
                <button className="rounded-md bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 px-3 py-1 text-sm">Record verdict</button>
              </form>
            </div>
          </div>
        </Card>
      </main>
    </>
  );
}
