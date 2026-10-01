import { requireFounder } from "@/lib/hq/guard";
import { fleetTenantIds, getBusinessStatus, getFleet } from "@/lib/hq/fleet";
import { resolveBusinessGraph } from "@/lib/business-graph-repository";
import { activityPulse, type ActivityEvent } from "@/lib/hq/activity";
import { hqShellData } from "@/lib/hq/shell-data";
import { HqShell } from "@/components/hq/HqShell";
import { ActivityList } from "@/components/hq/views";
import { HeroBrief, Page, Section } from "@/components/ds/primitives";

/** ACTIVITY — what BARRY and people did across the fleet: effects, approvals, payments, handoffs, obligations, incidents, founder changes. */
export default async function HqActivityPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  await requireFounder();
  const now = new Date();
  const { kind } = await searchParams;
  const fleet = await getFleet({ now });
  const details = await Promise.all(fleetTenantIds().map((id) => getBusinessStatus(resolveBusinessGraph(id), { now, detail: true })));
  const tz = new Map(details.map((d) => [d.id, d.timezone]));
  const all: ActivityEvent[] = details.flatMap((d) => d.activity).sort((a, b) => b.at.localeCompare(a.at));
  const events = (kind ? all.filter((e) => e.kind === kind) : all).slice(0, 120);
  const pulse = activityPulse(all, now);
  return (
    <HqShell active="activity" data={hqShellData(fleet)}>
      <Page>
        <HeroBrief eyebrow="Activity" title={`${pulse.total} thing${pulse.total === 1 ? "" : "s"} happened in the last day`} lead={`${pulse.consequential} consequential · ${pulse.unverified} not yet verified · ${pulse.stillNeeded} still need someone. Every line: what, for whom, who did it, verified or not, what is still needed — with its evidence one tap away. No raw logs.`} />
        <Section
          right={
            <form method="get" className="text-[12px]">
              <select name="kind" defaultValue={kind ?? ""} className="rounded-lg border border-[#d0d5dd] bg-white px-2 py-1.5 text-[12px]" aria-label="Filter by kind" onChange={undefined}>
                <option value="">All kinds</option>
                {(["effect", "approval", "payment", "handoff", "obligation", "incident", "founder_control", "delivery"] as const).map((k) => (
                  <option key={k} value={k}>{k.replace(/_/g, " ")}</option>
                ))}
              </select>{" "}
              <button className="rounded-lg border border-[#d0d5dd] px-2 py-1.5">Filter</button>
            </form>
          }
        >
          <ActivityList events={events} timezone={(e) => tz.get(e.businessId) ?? "UTC"} now={now} showBusiness />
        </Section>
      </Page>
    </HqShell>
  );
}
