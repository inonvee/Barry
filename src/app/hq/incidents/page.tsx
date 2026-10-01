import { requireFounder } from "@/lib/hq/guard";
import { getFleet } from "@/lib/hq/fleet";
import { hqShellData } from "@/lib/hq/shell-data";
import { HqShell } from "@/components/hq/HqShell";
import { IncidentItem, prioritizeIncidents } from "@/components/hq/views";
import { EmptyState, HeroBrief, Page, Section } from "@/components/ds/primitives";

/** INCIDENTS — a dedicated surface: new and unacknowledged first, then high, recurring, active. Acknowledge or resolve with a note. */
export default async function HqIncidentsPage() {
  await requireFounder();
  const now = new Date();
  const fleet = await getFleet({ now });
  const rows = prioritizeIncidents(fleet.businesses.flatMap((b) => b.incidents.open.map((incident) => ({ b, incident }))));
  const fresh = rows.filter((r) => r.incident.status === "current").length;
  const high = rows.filter((r) => r.incident.severity === "high").length;
  return (
    <HqShell active="incidents" data={hqShellData(fleet)}>
      <Page>
        <HeroBrief eyebrow="Incidents" title={rows.length === 0 ? "Nothing is broken or stuck by the records." : `${rows.length} open incident${rows.length === 1 ? "" : "s"} · ${fresh} unacknowledged · ${high} high`} lead="Each incident separates the customer impact from the technical cause and says what to do next. Acknowledging says you saw it; resolving closes it — if the symptom returns later it reopens on its own." />
        <Section>
          {rows.length === 0 ? (
            <EmptyState title="No open incidents">Model failures, stuck requests, failed writes, undelivered replies, unhealthy connections and stale payment links show here as they are derived from the records.</EmptyState>
          ) : (
            <div className="divide-y divide-[#f2f4f7]">
              {rows.map(({ b, incident }) => (
                <IncidentItem key={`${b.id}:${incident.key}`} i={incident} businessId={b.id} businessName={b.name} timezone={b.timezone} now={now} back="/hq/incidents" />
              ))}
            </div>
          )}
        </Section>
      </Page>
    </HqShell>
  );
}
