import Link from "next/link";
import { requireFounder } from "@/lib/hq/guard";
import { getFleet } from "@/lib/hq/fleet";
import { loadPins, loadRecent } from "@/lib/hq/visits";
import { hqShellData } from "@/lib/hq/shell-data";
import { HqShell } from "@/components/hq/HqShell";
import { PinButton } from "@/components/hq/views";
import { HeroBrief, Kv, Page, Section, Technical } from "@/components/ds/primitives";

/** SETTINGS — the founder's own state (pins, recents), the environment, and links to the technical tools. */
export default async function HqSettingsPage() {
  await requireFounder();
  const [fleet, pins, recent] = await Promise.all([getFleet(), loadPins(), loadRecent()]);
  return (
    <HqShell active="settings" data={hqShellData(fleet)}>
      <Page width="narrow">
        <HeroBrief eyebrow="Settings" title="Your HQ" lead="What you follow, where you were, and the environment this HQ runs on. Business behaviour is never changed from here — that is each business's Controls view." />
        <div className="flex flex-col gap-5">
          <Section title="Pinned businesses" subtitle="Pinned businesses lead the Fleet and appear on Focus.">
            <ul className="divide-y divide-[#f2f4f7]">
              {fleet.businesses.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/hq/${encodeURIComponent(b.id)}`} className="text-[14px] font-medium hover:underline">{b.name}</Link>
                  <PinButton businessId={b.id} pinned={pins.businessIds.includes(b.id)} back="/hq/settings" />
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Recent" subtitle="The surfaces you opened most recently.">
            {recent.length === 0 ? <p className="text-[13px] text-[#667085]">Nothing yet.</p> : (
              <ul className="divide-y divide-[#f2f4f7]">
                {recent.map((r) => (
                  <li key={r.href} className="py-2"><Link href={r.href} className="text-[14px] hover:underline">{r.label}</Link></li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Environment" subtitle="Technical. Raw values are fine here.">
            <Kv k="Build" v={<Technical>{fleet.build.commit ?? "local"}</Technical>} />
            <Kv k="Runtime" v={fleet.build.runtime} />
            <Kv k="Environment" v={fleet.build.environment} />
            <Kv k="Storage" v={fleet.businesses[0]?.storage ?? "—"} />
            <Kv k="Session" v="Founder (HQ token)" />
          </Section>
          <Section title="Tools" subtitle="For the BARRY team.">
            <ul className="flex flex-wrap gap-2 text-[13px]">
              <li><Link href="/qa" className="underline">QA tools</Link></li>
              <li><Link href="/simulator" className="underline">Simulator</Link></li>
              <li><Link href="/owner" className="underline">Owner product</Link></li>
              <li><Link href="/owner/train" className="underline">Train BARRY</Link></li>
              <li><form action="/api/hq/logout" method="post"><button className="underline">Sign out</button></form></li>
            </ul>
          </Section>
        </div>
      </Page>
    </HqShell>
  );
}
