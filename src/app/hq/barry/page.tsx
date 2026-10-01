import Link from "next/link";
import { requireFounder } from "@/lib/hq/guard";
import { getFleet } from "@/lib/hq/fleet";
import { hqShellData } from "@/lib/hq/shell-data";
import { HqShell } from "@/components/hq/HqShell";
import { STAGE_WORDS } from "@/components/hq/views";
import { FocusItem, FocusList, HeroBrief, Page, Section, StatusPill } from "@/components/ds/primitives";

/** BARRY — capabilities and model health across the fleet: what BARRY can operate where, and what is degraded. */
export default async function HqBarryPage() {
  await requireFounder();
  const now = new Date();
  const fleet = await getFleet({ now });
  const degraded = fleet.businesses.filter((b) => b.model.status === "unavailable" || b.model.status === "degraded");
  return (
    <HqShell active="barry" data={hqShellData(fleet)}>
      <Page>
        <HeroBrief eyebrow="BARRY" title={degraded.length ? `BARRY is degraded at ${degraded.length} business${degraded.length === 1 ? "" : "es"}.` : "BARRY is healthy everywhere it runs."} lead={`Runtime ${fleet.build.runtime} · ${fleet.build.environment}. Model and provider health per business; the capability detail lives in each business's Capabilities view.`} />
        <Section title="Per business">
          <FocusList>
            {fleet.businesses.map((b) => (
              <FocusItem
                key={b.id}
                status={b.model.status === "unavailable" ? "blocked" : b.model.status === "degraded" ? "degraded" : b.model.mode === "simulated" ? "simulator" : "ok"}
                title={b.name}
                why={`${b.model.mode === "live_model" ? `Live model${b.model.model ? ` · ${b.model.model}` : ""}` : "Simulated reasoner"} · ${b.model.summary}`}
                meta={
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusPill status={b.stage === "live_ready" ? "ok" : b.stage === "supervised" ? "info" : "simulator"}>{STAGE_WORDS[b.stage]}</StatusPill>
                    <span>commerce {b.providers.commerce} · payments {b.providers.payments} · scheduling {b.providers.scheduling} · WhatsApp {b.channel.whatsapp.replace(/_/g, " ")} · storage {b.storage}</span>
                  </span>
                }
                href={`/hq/${encodeURIComponent(b.id)}?view=capabilities`}
              />
            ))}
          </FocusList>
        </Section>
        <p className="mt-4 text-[12px] text-[#98a2b3]">
          <Link href="/hq/settings" className="hover:underline">Settings ›</Link>
        </p>
      </Page>
    </HqShell>
  );
}
