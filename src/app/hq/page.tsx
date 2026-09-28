import Link from "next/link";
import { requireFounder } from "@/lib/hq/guard";
import { getHqOverview } from "@/lib/hq/service";
import { Badge, Card, HqHeader, Kv, WithSource, label, n, statusTone } from "@/components/hq/ui";

export default async function HqOverviewPage() {
  await requireFounder();
  const { genomeSource, businesses } = await getHqOverview();

  return (
    <>
      <HqHeader crumbs={[]} />
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
        <div>
          <h1 className="text-lg font-semibold">Businesses</h1>
          <p className="text-xs text-neutral-500">Genome source: {genomeSource}. Readiness is the same computation the owner sees in Learn Business.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {businesses.map((b) => (
            <Card
              key={b.id}
              title={b.id}
              right={
                <WithSource value={b.readiness}>{(r) => <Badge tone={statusTone(r.operational.state)}>{label(r.operational.state)}</Badge>}</WithSource>
              }
            >
              <Link href={`/hq/${encodeURIComponent(b.id)}`} className="text-base font-semibold hover:underline">
                {b.name}
              </Link>
              <div className="mt-2 space-y-0.5">
                <Kv k="Providers" v={<WithSource value={b.mode}>{(m) => <Badge tone={statusTone(m)}>{m === "none" ? "none connected" : m}</Badge>}</WithSource>} />
                <Kv
                  k="Capabilities"
                  v={
                    <WithSource value={b.capabilities}>
                      {(caps) => (
                        <span className="flex flex-wrap justify-end gap-1">
                          {caps.filter((c) => c.needed).map((c) => (
                            <Badge key={c.capability} tone={statusTone(c.status)}>
                              {c.capability}: {label(c.status)}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </WithSource>
                  }
                />
                <Kv k="Conversations" v={<WithSource value={b.conversations}>{(c) => c.total}</WithSource>} />
                <Kv
                  k="Recent turn failures"
                  v={
                    <WithSource value={b.health}>
                      {(h) =>
                        h.sampled === 0
                          ? "no turns yet"
                          : `${h.failedSteps} failed steps · ${h.understandingFailed} not understood · ${h.contractFallbacks} reply fallbacks (last ${h.sampled} turns)`
                      }
                    </WithSource>
                  }
                />
                <Kv k="Pending approvals" v={n(b.counts.approvalsPending)} />
                <Kv k="Orders · bookings" v={`${n(b.counts.orders)} · ${n(b.counts.bookingsConfirmed)}`} />
                <Kv k="Payments paid / pending / failed" v={`${n(b.counts.paymentsPaid)} / ${n(b.counts.paymentsPending)} / ${n(b.counts.paymentsFailed)}`} />
                <Kv
                  k="Runtime / model"
                  v={
                    <WithSource value={b.runtime}>
                      {(rt) => (rt ? `${rt.barryVersion} · ${rt.model ?? rt.reasoner}${rt.reasoningEffort ? ` (${rt.reasoningEffort})` : ""}` : "not tracked (no traced turns)")}
                    </WithSource>
                  }
                />
              </div>
              <WithSource value={b.readiness}>
                {(r) =>
                  r.operational.blockers.length > 0 ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-neutral-500">{r.operational.blockers.length} blockers</summary>
                      <ul className="mt-1 space-y-1 text-xs">
                        {r.operational.blockers.map((x, i) => (
                          <li key={i}>
                            <span className="font-medium">{x.capability}:</span> {x.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null
                }
              </WithSource>
            </Card>
          ))}
        </div>
      </main>
    </>
  );
}
