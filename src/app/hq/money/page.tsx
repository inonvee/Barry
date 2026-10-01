import { requireFounder } from "@/lib/hq/guard";
import { getFleet } from "@/lib/hq/fleet";
import { hqShellData } from "@/lib/hq/shell-data";
import { hasMoney } from "@/lib/format/money";
import { HqShell } from "@/components/hq/HqShell";
import { MoneyLine } from "@/components/hq/views";
import { EmptyState, FocusItem, FocusList, HeroBrief, Page, Section } from "@/components/ds/primitives";

/** MONEY — across the fleet: blocked with owners, waiting on customers, at risk, test money apart. Per currency, never summed. */
export default async function HqMoneyPage() {
  await requireFounder();
  const now = new Date();
  const fleet = await getFleet({ now });
  const blocked = fleet.businesses.filter((b) => hasMoney(b.money.stuckWithOwner) || hasMoney(b.money.atRisk));
  const waiting = fleet.businesses.filter((b) => hasMoney(b.money.waitingOnCustomer));
  const verified = fleet.businesses.reduce((n, b) => n + b.money.verifiedPayments, 0);
  return (
    <HqShell active="money" data={hqShellData(fleet)}>
      <Page>
        <HeroBrief eyebrow="Money" title={blocked.length === 0 ? "No money is blocked anywhere." : `Money is blocked at ${blocked.length} business${blocked.length === 1 ? "" : "es"}.`} lead={`${verified} provider-verified payment${verified === 1 ? "" : "s"} on record across the fleet (test money apart). Figures stay in their own currency; BARRY never adds across currencies.`} />
        <div className="flex flex-col gap-5">
          <Section title="Blocked" subtitle="Waiting on an owner's decision, or at risk of being lost.">
            {blocked.length === 0 ? <EmptyState>Nothing blocked.</EmptyState> : (
              <FocusList>
                {blocked.map((b) => (
                  <FocusItem key={b.id} status="attention" title={b.name} why={<span className="flex flex-wrap gap-x-4">{hasMoney(b.money.stuckWithOwner) && <span>With the owner: <MoneyLine money={b.money.stuckWithOwner} status="blocked" /></span>}{hasMoney(b.money.atRisk) && <span>At risk: <MoneyLine money={b.money.atRisk} /></span>}</span>} href={`/hq/${encodeURIComponent(b.id)}?view=money`} />
                ))}
              </FocusList>
            )}
          </Section>
          <Section title="Waiting on customers" subtitle="Unpaid links and open requests BARRY is watching.">
            {waiting.length === 0 ? <EmptyState>Nothing waits on a customer.</EmptyState> : (
              <FocusList>
                {waiting.map((b) => (
                  <FocusItem key={b.id} status="neutral" title={b.name} why={<MoneyLine money={b.money.waitingOnCustomer} />} href={`/hq/${encodeURIComponent(b.id)}?view=money`} />
                ))}
              </FocusList>
            )}
          </Section>
          <Section title="BARRY MADE · BARRY SAVED" subtitle="Cross-business profit opportunities appear here once cost evidence is connected. Nothing is estimated as realised.">
            <p className="text-[13px] text-[#667085]">No cost evidence is connected for any business yet, so there are zero real opportunities. Verified revenue lives in each business&apos;s Money view.</p>
          </Section>
          {fleet.businesses.some((b) => hasMoney(b.money.simulated)) && (
            <Section title="Test money (apart)" subtitle="Simulated providers. Never counted as collected.">
              <FocusList>
                {fleet.businesses.filter((b) => hasMoney(b.money.simulated)).map((b) => (
                  <FocusItem key={b.id} status="simulator" title={b.name} why={<MoneyLine money={b.money.simulated} />} href={`/hq/${encodeURIComponent(b.id)}?view=money`} />
                ))}
              </FocusList>
            </Section>
          )}
        </div>
      </Page>
    </HqShell>
  );
}
