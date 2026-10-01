import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFounder } from "@/lib/hq/guard";
import { getHqBusiness } from "@/lib/hq/service";
import { fleetTenant, getBusinessStatus, getFleet } from "@/lib/hq/fleet";
import { groupLaunch, launchChecklist } from "@/lib/hq/launch";
import { businessPresence } from "@/lib/hq/presence";
import { loadPins, loadRecent, pushRecent, saveRecent } from "@/lib/hq/visits";
import { hqShellData } from "@/lib/hq/shell-data";
import { getConversationStore } from "@/lib/state";
import { financialImpact, profitOpportunities } from "@/lib/finance/impact";
import { getOwnerWorkspace } from "@/lib/owner/service";
import { NEXT_MOVE_WORDS, isOpen } from "@/lib/operator/obligation-model";
import { formatLocal } from "@/lib/format/time";
import { hasMoney } from "@/lib/format/money";
import { HqShell } from "@/components/hq/HqShell";
import { ActivityList, ControlActions, IncidentItem, LaunchGrouped, MoneyLine, PinButton, STAGE_WORDS, businessSentence, healthStatus, stageStatus } from "@/components/hq/views";
import { TechnicalView } from "@/components/hq/technical";
import { Badge, WithSource, label, statusTone } from "@/components/hq/ui";
import { Disclosure, EmptyState, FocusItem, FocusList, HeroBrief, Notice, Page, Section, StatusPill, Technical } from "@/components/ds/primitives";
import { describeChange } from "@/lib/hq/controls";

const VIEWS = ["overview", "attention", "activity", "money", "capabilities", "launch", "controls", "technical"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = { overview: "Overview", attention: "Needs attention", activity: "Activity", money: "Money", capabilities: "Capabilities", launch: "Launch", controls: "Controls", technical: "Technical" };

/** The 30-day window start (computed outside render so the page stays pure). */
function thirtyDaysAgo(now: Date): string {
  return new Date(now.getTime() - 30 * 24 * 3600_000).toISOString();
}

/**
 * BUSINESS FOCUS MODE — one business, one sentence, one sub-navigation. Overview is the brief; every
 * other view is one concern. Technical is the only place raw ids and traces live.
 */
export default async function HqBusinessPage({ params, searchParams }: { params: Promise<{ businessId: string }>; searchParams: Promise<{ view?: string; noop?: string }> }) {
  await requireFounder();
  const { businessId } = await params;
  const sp = await searchParams;
  const view: View = (VIEWS as readonly string[]).includes(sp.view ?? "") ? (sp.view as View) : "overview";
  const b = await getHqBusiness(businessId);
  if (!b) notFound();
  const graph = fleetTenant(businessId)!;
  const now = new Date();
  const [fleet, status, pins, recent] = await Promise.all([getFleet({ now }), getBusinessStatus(graph, { now, detail: true }), loadPins(), loadRecent()]);
  await saveRecent(pushRecent(recent, { href: `/hq/${encodeURIComponent(b.id)}${view === "overview" ? "" : `?view=${view}`}`, label: `${b.name} · ${VIEW_LABEL[view]}`, at: now.toISOString() })).catch(() => undefined);
  const tz = status.timezone;
  const base = `/hq/${encodeURIComponent(b.id)}`;
  const href = (v: View) => (v === "overview" ? base : `${base}?view=${v}`);
  const openIncidents = status.incidents.open;
  const queue = status.interventionQueue;
  const openObligations = status.obligationList.filter(isOpen);
  const shell = hqShellData(fleet, { presence: businessPresence(status) });

  return (
    <HqShell active="business" data={shell}>
      <Page>
        <HeroBrief
          eyebrow={
            <span className="flex flex-wrap items-center gap-2">
              <Link href="/hq/fleet" className="hover:underline">Fleet</Link>
              <span>›</span>
              <span>{b.name}</span>
            </span>
          }
          title={b.name}
          lead={
            <span className="flex flex-col gap-2">
              <span className="flex flex-wrap items-center gap-2">
                <StatusPill status={healthStatus(status)} />
                <StatusPill status={stageStatus(status)}>{STAGE_WORDS[status.stage]}</StatusPill>
                {!(status.stage === "simulator_only" && status.controls.mode === "simulator") && <StatusPill status={status.controls.mode === "live" ? "ok" : status.controls.mode === "supervised" ? "info" : "simulator"}>mode: {status.controls.mode}</StatusPill>}
                <span className="text-[12px] text-[#98a2b3]">{b.timezone} · {b.locale}</span>
              </span>
              <span>{businessSentence(status)}</span>
            </span>
          }
          aside={<PinButton businessId={b.id} pinned={pins.businessIds.includes(b.id)} back={href(view)} />}
        />

        <nav className="-mx-4 mb-5 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="Business views">
          <ul className="flex min-w-max gap-1 border-b border-[#e4e7ec]">
            {VIEWS.map((v) => (
              <li key={v}>
                <Link href={href(v)} aria-current={view === v ? "page" : undefined} className={`inline-block whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-medium ${view === v ? "border-[#1d2939] text-[#101828]" : "border-transparent text-[#667085] hover:text-[#101828]"}`}>
                  {VIEW_LABEL[v]}
                  {v === "attention" && openIncidents.length + queue.length > 0 && <span className="ml-1.5 rounded-full bg-[#b42318] px-1.5 text-[11px] text-white">{openIncidents.length + queue.length}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {status.unavailable.length > 0 && (
          <div className="mb-4">
            <Notice status="unknown" title="Some sources could not be read">{status.unavailable.join(", ")} — figures from them are shown as unavailable, never as zero.</Notice>
          </div>
        )}

        {view === "overview" && (
          <div className="flex flex-col gap-5">
            <Section title="Needs attention" subtitle={openIncidents.length + queue.length ? "Top items. The full list is under Needs attention." : undefined} right={<Link href={href("attention")} className="text-[13px] text-[#475467] hover:underline">All ›</Link>}>
              {openIncidents.length + queue.length === 0 ? <EmptyState title="Nothing waits on a person">Approvals, held requests, handoffs and incidents show here.</EmptyState> : (
                <FocusList>
                  {openIncidents.slice(0, 2).map((i) => (
                    <FocusItem key={i.key} status={i.severity === "high" ? "blocked" : "attention"} title={i.title} why={i.impact} move={i.nextAction} href={`${href("attention")}#${encodeURIComponent(i.key)}`} />
                  ))}
                  {queue.slice(0, 3).map((q) => (
                    <FocusItem key={q.id} status={q.priority === 1 ? "attention" : q.priority === 2 ? "blocked" : "neutral"} title={q.title} why={q.why} move={q.decision} meta={`${q.customer} · since ${formatLocal(q.since, tz, now)}`} href={`${base}/conversations/${encodeURIComponent(q.conversationId)}`} />
                  ))}
                </FocusList>
              )}
            </Section>
            <Section title="Money" right={<Link href={href("money")} className="text-[13px] text-[#475467] hover:underline">Money ›</Link>}>
              <dl className="grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2">
                <dt className="text-[#667085]">With the owner</dt><dd><MoneyLine money={status.money.stuckWithOwner} status={hasMoney(status.money.stuckWithOwner) ? "blocked" : undefined} /></dd>
                <dt className="text-[#667085]">At risk</dt><dd><MoneyLine money={status.money.atRisk} /></dd>
                <dt className="text-[#667085]">Waiting on customers</dt><dd><MoneyLine money={status.money.waitingOnCustomer} /></dd>
                <dt className="text-[#667085]">Verified payments</dt><dd className="tabular-nums">{status.money.verifiedPayments}</dd>
              </dl>
            </Section>
            <Section title="BARRY is watching" subtitle={`${openObligations.length} open · ${status.obligations.needsOwner} need the owner · ${status.obligations.barryCanAct} BARRY can act · ${status.obligations.waitingOnCustomer} on customers · ${status.obligations.blocked} blocked`}>
              {openObligations.length === 0 ? <p className="text-[13px] text-[#667085]">Nothing outstanding by the records.</p> : (
                <FocusList>
                  {openObligations.slice(0, 4).map((o) => (
                    <FocusItem key={o.key} status={o.nextMove === "needs_owner" ? "attention" : o.nextMove === "blocked_by_capability" ? "blocked" : "neutral"} title={`${o.customer}: ${o.subject}`} why={o.reason} move={`${NEXT_MOVE_WORDS[o.nextMove]} — ${o.nextAction}`} meta={o.dueAt ? `Due ${formatLocal(o.dueAt, tz, now)}` : undefined} href={`${base}/conversations/${encodeURIComponent(o.conversationId)}`} />
                  ))}
                </FocusList>
              )}
            </Section>
            <Section title="Latest activity" right={<Link href={href("activity")} className="text-[13px] text-[#475467] hover:underline">All activity ›</Link>}>
              <ActivityList events={status.activity.slice(0, 5)} timezone={() => tz} now={now} />
            </Section>
          </div>
        )}

        {view === "attention" && (
          <div className="flex flex-col gap-5">
            <Section title="Incidents" subtitle={openIncidents.length ? "Impact, technical cause and the next move for each." : undefined}>
              {openIncidents.length === 0 ? <EmptyState>No open incidents.</EmptyState> : (
                <div className="divide-y divide-[#f2f4f7]">
                  {openIncidents.map((i) => (
                    <IncidentItem key={i.key} i={i} businessId={b.id} timezone={tz} now={now} back={href("attention")} />
                  ))}
                </div>
              )}
            </Section>
            <Section title="Waiting on the owner" subtitle="The owner's queue, as the owner sees it. HQ never decides for them.">
              {queue.length === 0 ? <EmptyState>Nothing waits on the owner.</EmptyState> : (
                <FocusList>
                  {queue.map((q) => (
                    <FocusItem key={q.id} status={q.priority === 1 ? "attention" : q.priority === 2 ? "blocked" : "neutral"} title={q.title} why={q.why} move={`${q.decision} Then: ${q.then}`} meta={`${q.customer} · since ${formatLocal(q.since, tz, now)} · ${q.freshness}`} href={`${base}/conversations/${encodeURIComponent(q.conversationId)}`} />
                  ))}
                </FocusList>
              )}
            </Section>
          </div>
        )}

        {view === "activity" && (
          <Section title="Activity" subtitle="What BARRY and people did here — effects, approvals, payments, handoffs, obligations, incidents, founder changes.">
            <ActivityList events={status.activity} timezone={() => tz} now={now} />
          </Section>
        )}

        {view === "money" && <MoneyView status={status} now={now} tz={tz} graph={graph} base={base} />}

        {view === "capabilities" && (
          <div className="flex flex-col gap-5">
            <Section title="Model and systems">
              <dl className="grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2">
                <dt className="text-[#667085]">Model</dt><dd className="flex items-center gap-2"><StatusPill status={status.model.status === "unavailable" ? "blocked" : status.model.status === "degraded" ? "degraded" : status.model.mode === "simulated" ? "simulator" : "ok"} /> {status.model.summary}</dd>
                <dt className="text-[#667085]">Storage</dt><dd>{status.storage}</dd>
                <dt className="text-[#667085]">WhatsApp</dt><dd>{status.channel.whatsapp.replace(/_/g, " ")}</dd>
                <dt className="text-[#667085]">Providers</dt><dd>commerce {status.providers.commerce} · payments {status.providers.payments} · scheduling {status.providers.scheduling}</dd>
              </dl>
            </Section>
            <Section title="What BARRY can operate here">
              <WithSource value={b.capabilities}>
                {(caps) => (
                  <ul className="divide-y divide-[#f2f4f7]">
                    {caps.map((c) => (
                      <li key={c.capability} className="py-2.5 text-[13px]">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-[#101828]">{c.capability}</span>
                          <Badge tone={statusTone(c.status)}>{label(c.status)}</Badge>
                          {c.provider && <span className="text-[12px] text-[#667085]">{c.provider}</span>}
                        </div>
                        {c.canDo.length > 0 && <p className="text-[12px] text-[#475467]">Can: {c.canDo.join(", ")}</p>}
                        {c.needed && c.cannotDo.length > 0 && <p className="text-[12px] text-[#667085]">Cannot: {c.cannotDo.join(", ")}</p>}
                        {c.unlock && <p className="text-[12px] text-[#b54708]">{c.unlock}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </WithSource>
            </Section>
            <Section title="Readiness" subtitle="The same assessment the owner sees in Train BARRY.">
              <WithSource value={b.readiness}>
                {(r) => (
                  <>
                    <p className="text-[13px] text-[#344054]"><Badge tone={statusTone(r.understanding.state)}>{label(r.understanding.state)}</Badge> {r.understanding.requirementsMet} of {r.understanding.requirementsTotal} requirements · {r.understanding.verifiedFacts} facts verified, {r.understanding.candidateFacts} to review</p>
                    <ul className="mt-2 space-y-1 text-[13px]">
                      {r.operational.blockers.map((x, i) => (
                        <li key={i}><Badge tone="warn">{x.capability}</Badge> {x.reason} <span className="text-[#667085]">— {x.fix}</span></li>
                      ))}
                      {r.operational.blockers.length === 0 && <li className="text-[#667085]">No blockers.</li>}
                    </ul>
                  </>
                )}
              </WithSource>
            </Section>
          </div>
        )}

        {view === "launch" && <LaunchView graph={graph} status={status} businessId={b.id} />}

        {view === "controls" && (
          <div className="flex flex-col gap-5">
            {sp.noop === "1" && <Notice status="neutral" title="Nothing changed">The controls were already in that state, so nothing was written and nothing was added to the audit.</Notice>}
            <Section title="Founder controls" subtitle="Focused actions. Each states its scope, effect and reversibility, needs a reason and a confirmation, and is audited. Controls only ever tighten what the business's rules allow.">
              <ControlActions b={status} />
            </Section>
            <Section title="Audit" subtitle={`${status.audit.length} change${status.audit.length === 1 ? "" : "s"} · who, when, why, before → after.`}>
              {status.audit.length === 0 ? <p className="text-[13px] text-[#667085]">No founder changes yet.</p> : (
                <ul className="divide-y divide-[#f2f4f7]">
                  {status.audit.slice(0, 30).map((a) => (
                    <li key={a.id} className="py-2 text-[13px]">
                      <span className="text-[#667085]">{formatLocal(a.at, tz, now)} · {a.by}</span> — {describeChange(a)}
                      <Disclosure summary="before → after" muted>
                        <Technical>{JSON.stringify(a.before)}</Technical> → <Technical>{JSON.stringify(a.after)}</Technical>
                      </Disclosure>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}

        {view === "technical" && <TechnicalView b={b} />}
      </Page>
    </HqShell>
  );
}

async function LaunchView({ graph, status, businessId }: { graph: NonNullable<ReturnType<typeof fleetTenant>>; status: Awaited<ReturnType<typeof getBusinessStatus>>; businessId: string }) {
  const gate = await launchChecklist(graph, { controls: status.controls, conversations: await getConversationStore().listByBusiness(businessId).catch(() => []) });
  const grouped = groupLaunch(gate);
  return (
    <Section title="Design-partner launch" subtitle="Grouped by concern. The one blocker (or the one thing needing proof) is on top; evidence is under each group.">
      <LaunchGrouped grouped={grouped} level={gate.level} reason={gate.reason} />
    </Section>
  );
}

async function MoneyView({ status, now, tz, graph, base }: { status: Awaited<ReturnType<typeof getBusinessStatus>>; now: Date; tz: string; graph: NonNullable<ReturnType<typeof fleetTenant>>; base: string }) {
  const opportunities = profitOpportunities(status.id, []);
  const ws = await getOwnerWorkspace(graph, { since: thirtyDaysAgo(now), label: "last 30 days", now });
  const impact = financialImpact(ws.revenue, opportunities);
  const moneyObligations = status.obligationList.filter((o) => isOpen(o) && (o.kind === "unpaid_payment_followup" || o.kind === "booking_deposit_missing" || o.kind === "approval_blocking_transaction"));
  return (
    <div className="flex flex-col gap-5">
      <Section title="Where money stands" subtitle="Per currency. Never added across currencies; test money apart.">
        <dl className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
          <dt className="text-[#667085]">Collected (verified, last 30 days)</dt><dd><MoneyLine money={ws.revenue.direct} status="ok" empty="nothing yet" /></dd>
          <dt className="text-[#667085]">Booked, not collected</dt><dd><MoneyLine money={ws.revenue.influenced} empty="nothing" /></dd>
          <dt className="text-[#667085]">Pending (unpaid links)</dt><dd><MoneyLine money={ws.revenue.potential} empty="nothing" /></dd>
          <dt className="text-[#667085]">With the owner</dt><dd><MoneyLine money={status.money.stuckWithOwner} status={hasMoney(status.money.stuckWithOwner) ? "blocked" : undefined} /></dd>
          <dt className="text-[#667085]">At risk</dt><dd><MoneyLine money={status.money.atRisk} /></dd>
          <dt className="text-[#667085]">Test money (apart)</dt><dd><MoneyLine money={status.money.simulated} /></dd>
        </dl>
      </Section>
      <Section title="BARRY MADE · BARRY SAVED" subtitle="Generated and recovered are verified revenue. Savings are shown by state and never estimated as realised.">
        <dl className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
          <dt className="text-[#667085]">BARRY MADE · generated</dt><dd><MoneyLine money={impact.generated} status="ok" empty="nothing verified yet" /></dd>
          <dt className="text-[#667085]">of which recovered</dt><dd><MoneyLine money={impact.recovered} empty="none" /></dd>
          <dt className="text-[#667085]">BARRY SAVED · realised</dt><dd><MoneyLine money={impact.saved.realized} empty="none" /></dd>
          <dt className="text-[#667085]">potential / proposed / negotiated</dt><dd className="flex flex-wrap gap-x-3"><MoneyLine money={impact.saved.potential} empty="none" /> · <MoneyLine money={impact.saved.proposed} empty="none" /> · <MoneyLine money={impact.saved.negotiated} empty="none" /></dd>
        </dl>
        <p className="mt-2 text-[12px] text-[#667085]">{impact.evidenceCount === 0 ? "No cost evidence is connected yet, so there are zero real savings opportunities." : `${impact.evidenceCount} cost evidence records · ${opportunities.length} opportunities.`}</p>
      </Section>
      <Section title="Money BARRY is watching" subtitle="Unpaid links, deposits and blocked transactions, with whose move it is.">
        {moneyObligations.length === 0 ? <EmptyState>Nothing outstanding.</EmptyState> : (
          <FocusList>
            {moneyObligations.map((o) => (
              <FocusItem key={o.key} status={o.nextMove === "needs_owner" ? "attention" : o.nextMove === "blocked_by_capability" ? "blocked" : "neutral"} title={`${o.customer}: ${o.subject}`} why={o.reason} move={`${NEXT_MOVE_WORDS[o.nextMove]} — ${o.nextAction}`} meta={`${o.amount !== undefined && o.currency ? `${o.amount} ${o.currency} · ` : ""}${o.simulated ? "test · " : ""}${o.dueAt ? `due ${formatLocal(o.dueAt, tz, now)}` : `since ${formatLocal(o.createdAt, tz, now)}`}`} href={`${base}/conversations/${encodeURIComponent(o.conversationId)}`} />
            ))}
          </FocusList>
        )}
      </Section>
    </div>
  );
}
