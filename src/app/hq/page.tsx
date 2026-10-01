import Link from "next/link";
import { requireFounder } from "@/lib/hq/guard";
import { getFleet } from "@/lib/hq/fleet";
import { focusHeadline, focusItems } from "@/lib/hq/focus";
import { changesSince, loadLastVisit, loadPins, markVisit, snapshotOf } from "@/lib/hq/visits";
import { hqShellData } from "@/lib/hq/shell-data";
import { formatLocal } from "@/lib/format/time";
import { hasMoney } from "@/lib/format/money";
import { HqShell } from "@/components/hq/HqShell";
import { BusinessRow, ExceptionList, MoneyLine } from "@/components/hq/views";
import { Disclosure, EmptyState, FocusItem, FocusList, HeroBrief, Page, Section, buttonPrimary, buttonQuiet, input } from "@/components/ds/primitives";

/** A visit is a session: a snapshot older than this starts a new "since you were here". */
const VISIT_WINDOW_MS = 15 * 60_000;

/**
 * FOCUS — the default HQ landing. One sentence, the top 1–5 things that need the founder, what changed
 * since the last visit (derived from a durable snapshot), money blocked, the activity pulse and Ask HQ.
 * Not a data dump: Fleet, Incidents, Activity and Money each have their own surface.
 */
export default async function HqFocusPage() {
  await requireFounder();
  const now = new Date();
  const [fleet, lastVisit, pins] = await Promise.all([getFleet({ now }), loadLastVisit(), loadPins()]);
  const changes = changesSince(lastVisit, fleet);
  const sessionOld = !lastVisit || now.getTime() - Date.parse(lastVisit.at) > VISIT_WINDOW_MS;
  if (sessionOld) await markVisit(snapshotOf(fleet)).catch(() => undefined);
  const items = focusItems(fleet);
  const active = fleet.businesses.reduce((n, b) => n + b.conversations.last24h, 0);
  const consequential = fleet.summary.changed.length;
  const moneyBlocked = fleet.summary.moneyBlocked;
  const pinned = fleet.businesses.filter((b) => pins.businessIds.includes(b.id));
  // The fleet clock: the timezone most businesses run in (each business view uses its own).
  const tz = [...fleet.businesses.reduce((m, b) => m.set(b.timezone, (m.get(b.timezone) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "UTC";

  return (
    <HqShell active="focus" data={hqShellData(fleet)}>
      <Page>
        <HeroBrief
          eyebrow={`Focus · ${formatLocal(fleet.at, tz, now)} (${tz})`}
          title={focusHeadline(fleet, items.length)}
          lead={`${active} conversation${active === 1 ? "" : "s"} across the fleet in the last day · ${fleet.summary.healthy} of ${fleet.summary.businesses} healthy · ${fleet.summary.broke.length} open incident${fleet.summary.broke.length === 1 ? "" : "s"} above low · ${moneyBlocked.length ? `money blocked at ${moneyBlocked.length}` : "no money blocked"}.`}
          actions={
            <>
              <Link href="/hq/fleet" className={buttonQuiet}>Fleet ›</Link>
              <Link href="/hq/incidents" className={buttonQuiet}>Incidents ›</Link>
              <Link href="/hq/activity" className={buttonQuiet}>Activity ›</Link>
            </>
          }
        />

        <div className="flex flex-col gap-5">
          <Section title="Needs you" subtitle={items.length ? "In order. Each line says why and what the move is." : undefined}>
            {items.length === 0 ? <EmptyState title="Nothing waits on you">BARRY escalates here when a business has a high incident, a held request, an unavailable model or blocked money.</EmptyState> : <ExceptionList items={items} />}
          </Section>

          <Section title="Since you were here" subtitle={lastVisit ? `Last visit ${formatLocal(lastVisit.at, tz, now)}. Only derived changes: incidents, money, approvals, payments, capabilities, readiness, founder actions.` : "First visit — BARRY starts tracking changes from now."}>
            {changes.length === 0 ? (
              <p className="text-[13px] text-[#667085]">{lastVisit ? "Nothing changed by the records." : "Come back later to see what changed."}</p>
            ) : (
              <FocusList>
                {changes.slice(0, 8).map((c, i) => (
                  <FocusItem key={`${c.kind}:${c.businessId}:${i}`} status={c.kind === "incident_new" || c.kind === "money_blocked" || c.kind === "capability_degraded" ? "attention" : c.kind === "incident_resolved" || c.kind === "payment_verified" || c.kind === "capability_recovered" ? "ok" : "info"} title={c.what} meta={c.businessName} href={c.href} />
                ))}
                {changes.length > 8 && <p className="pt-2 text-[12px] text-[#667085]">+{changes.length - 8} more in Activity.</p>}
              </FocusList>
            )}
          </Section>

          <Section title="Money blocked" subtitle="Per business, per currency. Never added across currencies; never counted as revenue.">
            {moneyBlocked.length === 0 ? (
              <p className="text-[13px] text-[#667085]">No money waits on an owner or is at risk.</p>
            ) : (
              <FocusList>
                {moneyBlocked.map((m) => (
                  <FocusItem
                    key={m.id}
                    status="attention"
                    title={m.name}
                    why={
                      <span className="flex flex-wrap gap-x-4">
                        {hasMoney(m.stuckWithOwner) && <span>With the owner: <MoneyLine money={m.stuckWithOwner} status="blocked" /></span>}
                        {hasMoney(m.atRisk) && <span>At risk: <MoneyLine money={m.atRisk} /></span>}
                      </span>
                    }
                    href={`/hq/${encodeURIComponent(m.id)}?view=money`}
                  />
                ))}
              </FocusList>
            )}
          </Section>

          <Section title="Activity pulse" subtitle="What moved in the last day." right={<Link href="/hq/activity" className={buttonQuiet}>All activity ›</Link>}>
            <p className="text-[14px] text-[#344054]">
              {active} conversation{active === 1 ? "" : "s"} active · {consequential} change{consequential === 1 ? "" : "s"} recorded (founder actions and busy businesses) · {fleet.businesses.filter((b) => b.obligations.barryCanAct > 0).length} business{fleet.businesses.filter((b) => b.obligations.barryCanAct > 0).length === 1 ? "" : "es"} where BARRY can act on its own.
            </p>
            {fleet.summary.changed.length > 0 && (
              <Disclosure summary="Latest changes" muted>
                <ul className="space-y-1 text-[13px] text-[#475467]">
                  {fleet.summary.changed.slice(0, 6).map((c, i) => (
                    <li key={i}>
                      <Link href={`/hq/${encodeURIComponent(c.id)}?view=activity`} className="font-medium text-[#101828] hover:underline">{c.name}</Link> — {c.what}
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </Section>

          {pinned.length > 0 && (
            <Section title="Pinned" subtitle="Businesses you follow.">
              <div className="divide-y divide-[#f2f4f7]">
                {pinned.map((b) => (
                  <BusinessRow key={b.id} b={b} now={now} pinned />
                ))}
              </div>
            </Section>
          )}

          <Section title="Ask HQ BARRY" subtitle="Read-only answers from the same read models. Nothing here acts.">
            <form method="get" action="/hq/ask" className="flex flex-col gap-2 sm:flex-row">
              <input name="q" placeholder="Who needs me? Where is money stuck? What broke since the last build?" className={input} aria-label="Ask HQ BARRY" />
              <button className={`${buttonPrimary} sm:shrink-0`}>Ask</button>
            </form>
          </Section>
        </div>
      </Page>
    </HqShell>
  );
}
