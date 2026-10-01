import { requireFounder } from "@/lib/hq/guard";
import { getFleet } from "@/lib/hq/fleet";
import { loadPins } from "@/lib/hq/visits";
import { hqShellData } from "@/lib/hq/shell-data";
import { HqShell } from "@/components/hq/HqShell";
import { BusinessRow } from "@/components/hq/views";
import { HeroBrief, Page, Section } from "@/components/ds/primitives";

/** FLEET — one row per business: status word, one sentence, stage, incidents, money, last activity. Tap → focus. */
export default async function HqFleetPage() {
  await requireFounder();
  const now = new Date();
  const [fleet, pins] = await Promise.all([getFleet({ now }), loadPins()]);
  const order = (h: string) => (h === "unhealthy" ? 0 : h === "attention" ? 1 : 2);
  const rows = [...fleet.businesses].sort((a, b) => Number(pins.businessIds.includes(b.id)) - Number(pins.businessIds.includes(a.id)) || order(a.health) - order(b.health) || a.name.localeCompare(b.name));
  return (
    <HqShell active="fleet" data={hqShellData(fleet)}>
      <Page width="wide">
        <HeroBrief eyebrow="Fleet" title={`${fleet.summary.businesses} business${fleet.summary.businesses === 1 ? "" : "es"} · ${fleet.summary.healthy} healthy`} lead="Pinned first, then the ones that need attention. Each row is one sentence about where the business stands; tap it for the business focus." />
        <Section>
          <div className="divide-y divide-[#f2f4f7]">
            {rows.map((b) => (
              <BusinessRow key={b.id} b={b} now={now} pinned={pins.businessIds.includes(b.id)} />
            ))}
          </div>
        </Section>
      </Page>
    </HqShell>
  );
}
