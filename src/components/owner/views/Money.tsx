"use client";

import Link from "next/link";
import type { OwnerApproval, OwnerWorkspace } from "@/lib/owner/service";
import { financialImpact } from "@/lib/finance/impact";
import { workflows } from "@/lib/owner/control-room";
import { formatLocal } from "@/lib/format/time";
import { hasMoney } from "@/lib/format/money";
import { Empty, MoneyFigures, Pill, formatMoney, timeAgo, type Tone } from "../ui";
import { MoneyInMotion, WatchingList } from "../operating";
import { HeaderLink, Hero, Icon, MotionStat, Panel, PanelHeader, Segmented, StageTitle } from "../kit";
import { MotionStrip, WorkflowFlow } from "./live";
import { LIFECYCLE } from "./shared";

type Range = "today" | "7d" | "30d";

const REVENUE_CATEGORIES: { id: OwnerWorkspace["revenueEvidence"][number]["category"]; label: string; explain: string; tone: Tone }[] = [
  { id: "collected", label: "Made", explain: "Paid and verified by your payment provider — the only real revenue.", tone: "good" },
  { id: "recovered", label: "Recovered", explain: "Collected after an earlier failed or cancelled attempt (already inside Made).", tone: "good" },
  { id: "booked_not_collected", label: "Booked, not collected", explain: "Value of bookings BARRY made; not cash.", tone: "info" },
  { id: "open_opportunity", label: "Pending", explain: "Unpaid links and requests — not revenue. Simulated ones are marked as test money.", tone: "warn" },
  { id: "simulated", label: "Test money", explain: "Simulated providers — never counted.", tone: "neutral" },
  { id: "excluded_unverified", label: "Not counted", explain: "Marked paid without provider verification.", tone: "neutral" },
];

/**
 * MONEY — what money is moving because of BARRY. Five states that never blur: MADE (verified),
 * RECOVERED (verified, inside Made), PENDING, AT RISK, SAVED (realised only; Intelligence). Each amount
 * stays in its own currency and carries the record that proves it.
 */
export function MoneyView({ ws, range, setRange, onOpen, onIntervention, loadedAt }: { ws: OwnerWorkspace; range: Range; setRange: (r: Range) => void; onOpen: (id: string) => void; onIntervention: (id: string) => void; loadedAt: Date | null }) {
  const r = ws.revenue;
  const items = ws.revenueEvidence;
  const impact = financialImpact(r, []);
  const flows = workflows(ws).filter((f) => f.kind === "unpaid_payment_followup" || f.kind === "abandoned_checkout_recovery" || f.kind === "booking_deposit_missing");
  const margins = !ws.plan?.name || ws.plan.marginsIncluded;
  const title = hasMoney(r.direct) ? (
    <>
      BARRY made <span className="o-hero-type">{formatMoney(r.direct)}</span> {ws.window.label}.
    </>
  ) : (
    <>Nothing collected {ws.window.label} yet.</>
  );
  const saved = margins ? (
    <MotionStat icon="spark" tone="violet" label="Saved (realised)" value={hasMoney(impact.saved.realized) ? formatMoney(impact.saved.realized) : "—"} sub={impact.evidenceCount === 0 ? "Needs connected cost evidence" : "Only evidence-backed savings"} />
  ) : (
    <Link href="/owner/settings#plan" className="flex items-center gap-3 rounded-2xl px-1 py-3 transition hover:bg-o-sunken/40">
      <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-o-violet/10 text-o-violet ring-1 ring-inset ring-o-violet/30"><Icon name="lock" size={18} /></span>
      <span className="min-w-0">
        <span className="block text-[13px] text-o-muted">Saved</span>
        <span className="block text-[12.5px] leading-5 text-o-ink-2">BARRY Margins is part of BARRY Intelligence — not in your {ws.plan.name} plan. <span className="text-o-violet">See plan ›</span></span>
      </span>
    </Link>
  );
  return (
    <div className="flex flex-col gap-8 md:gap-10">
      <Hero
        eyebrow={`Money · ${ws.business.name}${loadedAt ? ` · ${formatLocal(loadedAt.toISOString(), ws.business.timezone, loadedAt)}` : ""}`}
        title={title}
        lead="Only provider-verified payments count as made. Everything else is shown apart, each currency on its own — never added together."
        right={<Segmented<Range> ariaLabel="Time range" value={range} onChange={setRange} options={[{ id: "today", label: "Today" }, { id: "7d", label: "7 days" }, { id: "30d", label: "30 days" }]} />}
      />

      <section aria-labelledby="in-motion">
        <StageTitle>
          <span id="in-motion" className="text-[17px] normal-case tracking-normal text-o-ink">Your business, in motion</span>
        </StageTitle>
        <div className="o-stage mt-3 px-4 py-1 md:px-6">
          <MotionStrip ws={ws} extra={saved} />
        </div>
        {ws.trend.currency && ws.trend.made.some((v) => v > 0) && <p className="mt-2 text-[12px] text-o-faint">Trend lines: verified {ws.trend.currency} per day, last 7 days. Test money never appears in them.</p>}
      </section>

      {flows.length > 0 && (
        <section className="o-stage p-5 md:p-7" aria-labelledby="work-to-money">
          <StageTitle live={flows.some((f) => f.open && f.state === "running") ? "live" : "off"} liveLabel={flows.some((f) => f.open && f.state === "running") ? "Live now" : undefined}>
            <span id="work-to-money">From BARRY&apos;s work to money</span>
          </StageTitle>
          <p className="mt-1.5 text-[13px] text-o-muted">Your follow-up rules, who BARRY reached, and what the payment provider verified. Money appears only once it is verified.</p>
          <div className="mt-6 flex flex-col gap-8">
            {flows.map((f, i) => (
              <div key={f.kind}>
                {i > 0 && <div className="o-hairline mb-8" />}
                <WorkflowFlow w={f} />
              </div>
            ))}
          </div>
        </section>
      )}

      {margins && (
        <section aria-labelledby="margins">
          <StageTitle>
            <span id="margins">BARRY Margins</span>
          </StageTitle>
          <p className="mt-1.5 text-[13px] text-o-muted">Savings move through four states; only REALISED counts as saved.</p>
          <ol className="relative mt-5 grid grid-cols-2 gap-x-3 gap-y-5 md:grid-cols-4">
            <span aria-hidden className="o-hairline absolute left-[6%] right-[6%] top-[7px] hidden md:block" />
            {([["Potential", impact.saved.potential, "Spotted in your cost evidence"], ["Proposed", impact.saved.proposed, "A concrete change is suggested"], ["Negotiated", impact.saved.negotiated, "Agreed, not yet in your books"], ["Realised", impact.saved.realized, "Proven by a later cost record"]] as const).map(([label, m, hint], i) => (
              <li key={label} className="relative">
                <span aria-hidden className={`relative z-10 block h-[15px] w-[15px] rounded-full ring-[3px] ring-o-canvas ${i === 3 ? "bg-o-ok shadow-[0_0_12px_rgba(61,220,151,0.7)]" : "bg-o-line-strong"}`} />
                <p className={`mt-3 text-[11px] font-semibold uppercase tracking-[0.14em] ${i === 3 ? "text-o-ok" : "text-o-faint"}`}>{label}</p>
                <p className={`mt-1 text-[20px] font-semibold tabular-nums ${i === 3 ? "text-o-ok" : "text-o-ink"}`}>{hasMoney(m) ? formatMoney(m) : "—"}</p>
                <p className="text-[12px] text-o-muted">{hint}</p>
              </li>
            ))}
          </ol>
          {impact.evidenceCount === 0 && <p className="mt-4 text-[12.5px] text-o-muted">BARRY Margins needs connected cost evidence — nothing is connected yet, so there is nothing to save from. BARRY will not invent a saving.</p>}
        </section>
      )}

      <section>
        <PanelHeader icon="money" tone="ok" title="Money in motion" sub="What can be done about it — each line says whose move it is." />
        <div className="mt-4">
          <MoneyInMotion items={ws.opportunities.items} summary={ws.opportunities.summary} onOpen={onOpen} onIntervention={onIntervention} />
        </div>
      </section>

      <div className="o-hairline" />

      <section>
        <PanelHeader icon="clock" title="Unpaid follow-ups" sub="Every unpaid link BARRY is watching, with whose move it is now." />
        <div className="mt-3">
          <WatchingList items={ws.obligations.filter((o) => o.kind === "unpaid_payment_followup" || o.kind === "booking_deposit_missing")} onOpen={onOpen} empty="No unpaid link or missing deposit is being watched." />
        </div>
      </section>

      <div className="o-hairline" />

      <section>
        <PanelHeader icon="receipt" title="Every amount, explained" sub="The state each amount is in, and the record that puts it there." />
        <div className="mt-3">
          {items.length === 0 ? (
            <Empty>No money records in this period yet.</Empty>
          ) : (
            <div className="flex flex-col gap-2">
              {REVENUE_CATEGORIES.filter((c) => items.some((i) => i.category === c.id)).map((c) => {
                const rows = items.filter((i) => i.category === c.id);
                const totals: Record<string, number> = {};
                for (const x of rows) totals[x.currency] = Math.round(((totals[x.currency] ?? 0) + x.amount) * 100) / 100;
                return (
                  <details key={c.id} className="group rounded-xl bg-o-sunken/60 p-3 ring-1 ring-inset ring-o-line">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
                      <span className="flex flex-wrap items-center gap-2">
                        <Pill tone={c.tone}>{c.label}</Pill>
                        <span className="text-[12px] text-o-muted">{c.explain}</span>
                      </span>
                      <span className="flex items-center gap-1.5 font-semibold tabular-nums text-o-ink">
                        {formatMoney(totals)}
                        <Icon name="chevron" size={14} className="text-o-faint transition group-open:rotate-90" />
                      </span>
                    </summary>
                    <ul className="mt-2 divide-y divide-o-line text-[13px]">
                      {rows.map((x, i) => (
                        <li key={i} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:justify-between">
                          <button className="min-w-0 break-words text-left text-o-ink-2 hover:text-o-ink" onClick={() => onOpen(x.conversationId)}>
                            {x.customer} — <span className="text-o-muted">{x.record}</span>
                            {x.simulated && (
                              <>
                                {" "}
                                <Pill tone="neutral">Test money</Pill>
                              </>
                            )}
                          </button>
                          <span className="shrink-0 tabular-nums text-o-ink">{formatMoney({ [x.currency]: x.amount })}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}
            </div>
          )}
        </div>
        {(hasMoney(r.simulatedPaid) || r.potentialSimulatedItems > 0) && (
          <p className="mt-3 text-[12px] text-o-faint">
            Test money (apart): <MoneyFigures money={r.simulatedPaid} empty="none paid" />
            {r.potentialSimulatedItems ? ` · ${formatMoney(r.potentialSimulated)} pending on a simulated provider` : ""} — never counted as made.
          </p>
        )}
        <p className="mt-1 text-[12px] text-o-faint">Converted: {r.purchaseIntentConversations ? `${r.convertedConversations} of ${r.purchaseIntentConversations}` : "—"} conversations with buying intent · {r.lostOpportunities} lost</p>
      </section>

      {ws.approvals.some((a) => !(a.actionable || a.lifecycle === "held")) && (
        <Panel className="p-4 md:p-5">
          <PanelHeader icon="shield" title="Decisions you made" right={<HeaderLink href="/owner?tab=actions">All actions</HeaderLink>} />
          <ul className="mt-2 divide-y divide-o-line">
            {ws.approvals
              .filter((a) => !(a.actionable || a.lifecycle === "held"))
              .slice(0, 8)
              .map((a) => (
                <DecisionRow key={a.id} a={a} onOpen={onOpen} />
              ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

export function DecisionRow({ a, onOpen }: { a: OwnerApproval; onOpen: (id: string) => void }) {
  const l = LIFECYCLE[a.lifecycle] ?? LIFECYCLE.approved;
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <button className="min-w-0 text-left" onClick={() => onOpen(a.conversationId)}>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={l.tone}>{l.label}</Pill>
          <span className="text-[14px] font-medium text-o-ink">{a.customer}</span>
        </div>
        <p className="mt-0.5 text-[13px] text-o-ink-2">
          {a.what}
          {a.resultReference ? ` · ${a.resultReference}` : ""}
        </p>
      </button>
      <span className="shrink-0 text-[12px] text-o-faint">{timeAgo(a.createdAt)}</span>
    </li>
  );
}
