"use client";

import Link from "next/link";
import { useState } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import { activityByHour, activityFeed, nowWorking, workflows } from "@/lib/owner/control-room";
import { hasMoney } from "@/lib/format/money";
import { formatMoney, StateNotice, timeAgo, btn } from "../ui";
import { InterventionQueue, MoneyInMotion, type Act } from "../operating";
import { ActivityRow, BigMetric, Bars, Flow, HeaderLink, Hero, Icon, IconTile, LiveDot, Panel, PanelHeader, ShareBar } from "../kit";
import { WhatsAppCard } from "../OwnerShell";
import { greeting, plural, type Tab } from "./shared";

/**
 * TODAY — the hero surface. Four questions, in this order: what needs me, what is BARRY doing now,
 * what did BARRY do, where is money moving. Every figure comes from the workspace read model.
 */
export function TodayView({ ws, act, busyId, loading, onOpen, onIntervention, onTab }: { ws: OwnerWorkspace; act: Act; busyId: string | null; loading: boolean; onOpen: (id: string) => void; onIntervention: (id: string) => void; onTab: (t: Tab) => void }) {
  const [showAll, setShowAll] = useState(false);
  const queue = ws.interventions;
  const t = ws.today;
  const ai = ws.health.ai;
  const working = nowWorking(ws);
  const feed = activityFeed(ws, 8);
  const flows = workflows(ws);
  const hours = activityByHour(ws);
  const needed = Math.max(0, t.conversations - t.handledAutonomously);
  const made = ws.revenue.direct;
  const atRisk = ws.opportunities.summary.atRisk;
  const setupSteps = ws.capabilities.steps.filter((s) => s.gate !== "customer_traffic").slice(0, 2);

  const title = queue.length === 0 ? (
    <>BARRY has it <span className="o-hero-type">handled.</span></>
  ) : (
    <>
      <span className="o-hero-type">{plural(queue.length, "thing")}</span> need{queue.length === 1 ? "s" : ""} you.
    </>
  );
  const lead = t.conversations
    ? `BARRY handled ${plural(t.handledAutonomously, "conversation")} on its own ${ws.window.label}${t.completedOutcomes ? ` and completed ${plural(t.completedOutcomes, "verified outcome")}` : ""}.${loading ? " Refreshing…" : ""}`
    : `No customer conversations ${ws.window.label} yet — BARRY is ready and watching.${loading ? " Refreshing…" : ""}`;

  return (
    <div className="flex flex-col gap-6">
      <Hero eyebrow={`${greeting()} · ${ws.business.name}`} title={title} lead={lead} />

      {(ai.status === "unavailable" || ai.status === "degraded") && (
        <StateNotice tone={ai.status === "unavailable" ? "bad" : "warn"} title={ai.status === "unavailable" ? "BARRY can't understand customers right now" : "BARRY had trouble understanding some messages"}>
          {ai.summary}
        </StateNotice>
      )}

      {/* The four numbers that matter today */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <BigMetric label="Needs you" icon="shield" iconTone={queue.length ? "warn" : "neutral"} value={queue.length} tone={queue.length ? "warn" : "ink"} sub={queue.length ? "Decisions waiting" : "Nothing waiting"} onClick={() => onTab("actions")} />
        <BigMetric label="Handled by BARRY" icon="barry" iconTone="accent" value={`${t.handledAutonomously}/${t.conversations}`} sub={t.conversations ? `${Math.round((t.handledAutonomously / t.conversations) * 100)}% without you` : "No conversations yet"} onClick={() => onTab("inbox")} />
        <BigMetric label="Made (verified)" icon="money" iconTone="ok" value={hasMoney(made) ? formatMoney(made) : "—"} tone={hasMoney(made) ? "ok" : "ink"} sub={`${plural(ws.revenue.directPayments, "verified payment")}${hasMoney(ws.revenue.recovered) ? ` · ${formatMoney(ws.revenue.recovered)} recovered` : ""}`} onClick={() => onTab("money")} />
        <BigMetric label="At risk" icon="alert" iconTone={hasMoney(atRisk) ? "bad" : "neutral"} value={hasMoney(atRisk) ? formatMoney(atRisk) : "—"} tone={hasMoney(atRisk) ? "bad" : "ink"} sub={hasMoney(atRisk) ? "Likely lost unless someone acts" : "Nothing at risk"} onClick={() => onTab("money")} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        {/* What needs me */}
        <section className="flex flex-col gap-3" aria-labelledby="needs-you">
          <div className="flex items-center justify-between">
            <h2 id="needs-you" className="flex items-center gap-2 text-[15px] font-semibold text-o-ink">
              <IconTile name="shield" tone={queue.length ? "warn" : "neutral"} size={28} /> Needs you
            </h2>
            {queue.length > 0 && <HeaderLink onClick={() => onTab("actions")}>All actions</HeaderLink>}
          </div>
          <InterventionQueue items={queue} busyId={busyId} onAct={act} limit={showAll ? undefined : 3} compact />
          {queue.length > 3 && !showAll && (
            <button className={`${btn} w-full sm:w-auto`} onClick={() => setShowAll(true)}>
              Show all {queue.length}
            </button>
          )}
        </section>

        {/* What BARRY is doing now */}
        <Panel className="p-4 md:p-5">
          <PanelHeader icon="pulse" title="BARRY is working" live={working.some((w) => w.state === "working") ? "live" : "waiting"} sub={working.length ? "Right now, from BARRY's open work." : "Nothing open — BARRY picks up the next message."} />
          {working.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {working.map((w) => (
                <li key={w.id} className="flex items-center gap-3 rounded-xl bg-o-sunken/60 px-3 py-2.5 ring-1 ring-inset ring-o-line">
                  <LiveDot state={w.state === "working" ? "working" : w.state === "attention" ? "attention" : w.state === "blocked" ? "attention" : "waiting"} />
                  <span className="flex-1 text-[13.5px] text-o-ink">{w.text}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-o-faint">Live activity</p>
            <HeaderLink onClick={() => onTab("inbox")}>Inbox</HeaderLink>
          </div>
          {feed.length === 0 ? (
            <p className="mt-2 text-[13px] text-o-muted">Payments, follow-ups, approvals and handoffs appear here the moment BARRY records them.</p>
          ) : (
            <ul className="mt-1 -mx-1.5">
              {feed.map((f) => (
                <ActivityRow key={f.id} icon={f.icon} tone={f.tone} text={f.text} sub={f.sub} when={timeAgo(f.at)} onClick={f.conversationId ? () => onOpen(f.conversationId!) : undefined} />
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* What BARRY did today */}
      <Panel className="p-4 md:p-5">
        <PanelHeader icon="barry" title="What BARRY did" sub={`${plural(t.conversations, "conversation")} ${ws.window.label} · ${t.completedOutcomes} verified outcomes${t.blockedOrFailed ? ` · ${t.blockedOrFailed} stopped or failed` : ""}`} right={<HeaderLink onClick={() => onTab("inbox")}>Conversations</HeaderLink>} />
        <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
          <ShareBar ariaLabel="Conversations handled by BARRY versus needing you" parts={[{ label: "Handled by BARRY", value: t.handledAutonomously, tone: "accent" }, { label: "Needed you", value: needed, tone: "warn" }]} />
          {hours.values.some((v) => v > 0) ? (
            <div>
              <Bars values={hours.values} labels={hours.labels} ariaLabel="Conversation activity by hour today" height={52} />
              <p className="mt-1.5 flex justify-between text-[11px] text-o-faint"><span>00:00</span><span>12:00</span><span>23:00</span></p>
            </div>
          ) : (
            <p className="text-[13px] text-o-muted">The activity curve fills in as conversations happen today.</p>
          )}
        </div>
      </Panel>

      {/* From rule to result */}
      <Panel className="p-4 md:p-5">
        <PanelHeader icon="bolt" tone="violet" title="From your rules to real results" sub="What started the work, what BARRY did, and what the records verify." />
        <div className="mt-4 flex flex-col gap-4">
          {flows.length === 0 ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <p className="text-[13px] leading-6 text-o-muted">When a payment link goes unpaid, a checkout is abandoned or a deposit is missing, BARRY follows up under your rules — and each run shows here as command → work → verified result.</p>
              <WhatsAppCard channels={ws.channels} wide />
            </div>
          ) : (
            flows.map((f) => (
              <Flow
                key={f.kind}
                command={f.command}
                commandBy={f.commandBy}
                work={[
                  { label: "Eligible", value: f.eligible },
                  { label: "Contacted", value: f.contacted },
                  { label: "Still open", value: f.open, tone: f.open ? "warn" : "muted" },
                  ...(f.excluded ? [{ label: "Excluded / cancelled", value: f.excluded, tone: "muted" as const }] : []),
                ]}
                outcome={[
                  { label: f.closedLabel, value: f.closed, tone: f.closed ? "ok" : "muted" },
                  ...(hasMoney(f.recovered) ? [{ label: "Recovered after follow-up", value: formatMoney(f.recovered), tone: "ok" as const }] : []),
                  ...(hasMoney(f.atStake) ? [{ label: "Still at stake", value: formatMoney(f.atStake), tone: "warn" as const }] : []),
                ]}
                note={f.testItems ? `${plural(f.testItems, "item")} on a simulated provider — counted above, never as money.` : undefined}
              />
            ))
          )}
        </div>
      </Panel>

      {/* Where money is moving */}
      <Panel className="p-4 md:p-5">
        <PanelHeader icon="money" tone="ok" title="Money in motion" sub="Where money is stuck, at risk or waiting — never counted as revenue." right={<HeaderLink onClick={() => onTab("money")}>All money</HeaderLink>} />
        <div className="mt-4">
          <MoneyInMotion items={ws.opportunities.items} summary={ws.opportunities.summary} onOpen={onOpen} onIntervention={onIntervention} limit={3} />
        </div>
      </Panel>

      {setupSteps.length > 0 && (
        <Panel className="p-4 md:p-5">
          <PanelHeader icon="spark" tone="violet" title="Unlock next" sub="What BARRY could do for you once it's set up." right={<HeaderLink href="/owner/train">Train BARRY</HeaderLink>} />
          <ul className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
            {setupSteps.map((s) => (
              <li key={s.id} className="rounded-xl bg-o-sunken/60 px-3.5 py-3 ring-1 ring-inset ring-o-line">
                <p className="flex items-center gap-2 text-[14px] font-medium text-o-ink">
                  <Icon name="lock" size={15} className="text-o-violet" /> {s.title} <span className="text-[12px] font-normal text-o-faint">· {s.who === "you" ? "you" : "BARRY team"}</span>
                </p>
                <p className="mt-1 text-[13px] text-o-muted">Then BARRY can: {s.unlocks.join(", ")}</p>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <p className="text-center text-[12px] text-o-faint">
        <Link href="/owner/train" className="hover:text-o-ink-2">Train BARRY</Link> · <Link href="/owner/settings#plan" className="hover:text-o-ink-2">Your plan</Link>
      </p>
    </div>
  );
}
