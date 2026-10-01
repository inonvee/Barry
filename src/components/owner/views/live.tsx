"use client";

import Link from "next/link";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { ActivityItem, Workflow } from "@/lib/owner/control-room";
import type { OwnerCommand } from "@/lib/owner/command";
import type { Intervention } from "@/lib/owner/interventions";
import { hasMoney } from "@/lib/format/money";
import type { Money } from "@/lib/owner/revenue";
import { formatMoney, timeAgo } from "../ui";
import type { Act } from "../operating";
import { BarryOrb, Icon, LiveDot, LiveFlow, MotionStat, Sparkline, type FlowBranch, type IconName } from "../kit";
import { plural, type Tab } from "./shared";

/**
 * THE LIVING INTERFACE — the pieces that make BARRY's work visible as it happens: a proactive
 * workflow as a live branching flow, the Needs-you interruption, money in motion, and BARRY's reply to
 * an owner command. All of it renders recorded state; none of it executes anything by itself.
 */

const FLOW_ICON: Partial<Record<Workflow["kind"], IconName>> = { unpaid_payment_followup: "money", abandoned_checkout_recovery: "cart", booking_deposit_missing: "receipt", appointment_reminder: "clock", failed_action_recovery: "bolt" };

export function workflowState(w: Workflow) {
  if (w.state === "not_in_plan") return <span className="rounded-full bg-o-neutral-bg px-2 py-0.5 text-[11px] font-medium text-o-muted ring-1 ring-inset ring-o-line">Not in your plan</span>;
  if (w.state === "off") return <span className="rounded-full bg-o-neutral-bg px-2 py-0.5 text-[11px] font-medium text-o-muted ring-1 ring-inset ring-o-line">Off in your rules</span>;
  if (w.open) return <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-o-ok"><LiveDot state="live" /> Live</span>;
  return <span className="text-[11.5px] font-medium text-o-faint">Nothing open</span>;
}

/** A proactive workflow as input → BARRY → branches → verified outcomes. Counts only; money only when verified. */
export function WorkflowFlow({ w }: { w: Workflow }) {
  const running = w.state === "running";
  const branches: FlowBranch[] = [
    { label: w.closedLabel, value: w.closed, tone: w.closed ? "ok" : "muted", sub: hasMoney(w.recovered) ? `${formatMoney(w.recovered)} recovered` : undefined },
    { label: "Followed up · waiting", value: w.waiting, tone: w.waiting ? "accent" : "muted", live: running && w.waiting > 0, sub: hasMoney(w.atStake) && w.waiting ? `${formatMoney(w.atStake)} still open` : undefined },
    ...(w.queued ? [{ label: running ? "Queued for follow-up" : "Not followed up", value: w.queued, tone: "accent" as const, live: running }] : []),
    ...(w.excluded ? [{ label: "Stopped / cancelled", value: w.excluded, tone: "muted" as const }] : []),
  ];
  return (
    <LiveFlow
      icon={FLOW_ICON[w.kind] ?? "bolt"}
      title={running ? w.title : w.command}
      state={workflowState(w)}
      sub={`${w.commandBy} · ${plural(w.contacted, "customer")} contacted so far`}
      source={w.eligible}
      sourceLabel={w.noun}
      branches={branches}
      note={w.testItems ? `${plural(w.testItems, "item")} on a simulated provider — counted here, never as money.` : undefined}
    />
  );
}

/** The few words of a decision's exact terms: "₪420 → ₪378", or the amount. */
function decisionFigure(item: Intervention): string | undefined {
  const m = item.title.match(/\(([^()]*→[^()]*)\)/);
  return m?.[1] ?? item.amount;
}

/**
 * NEEDS YOU — the interruption into BARRY's autonomous work. Lifted above everything else; shows the
 * first decision with its exact terms and the real primary option (approve still goes through the
 * owner endpoint, which re-checks everything), or Review for the full card.
 */
export function NeedsYouFloat({ ws, act, busyId, onReview }: { ws: OwnerWorkspace; act: Act; busyId: string | null; onReview: (id?: string) => void }) {
  const queue = ws.interventions;
  if (queue.length === 0) {
    return (
      <section className="o-float-calm o-rise p-5" aria-labelledby="needs-you">
        <h2 id="needs-you" className="flex items-center gap-2.5 text-[17px] font-semibold text-o-ink">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-o-ok/12 text-o-ok ring-1 ring-inset ring-o-ok/30"><Icon name="check" size={16} /></span>
          Nothing needs you
        </h2>
        <p className="mt-2 text-[13.5px] leading-6 text-o-muted">BARRY is handling everything inside your rules. Approvals, customers who need a person and anything that didn&apos;t go through land here first.</p>
      </section>
    );
  }
  const item = queue[0];
  const primary = item.options.find((o) => o.primary && o.action !== "open_conversation");
  const fig = decisionFigure(item);
  const busy = busyId === item.id;
  return (
    <section className="o-float o-rise p-5" aria-labelledby="needs-you" data-intervention-float={item.id}>
      <h2 id="needs-you" className="flex items-center gap-2.5 text-[18px] font-semibold text-o-warn">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-o-warn/12 ring-1 ring-inset ring-o-warn/40"><Icon name="alert" size={16} /></span>
        Needs you · {queue.length}
      </h2>
      <div className="mt-4 rounded-2xl bg-o-sunken/70 p-4 ring-1 ring-inset ring-o-line">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-o-accent/40 to-o-violet/40 text-[15px] font-semibold text-o-ink ring-1 ring-inset ring-white/10">{item.customer.replace(/[^\p{L}]/gu, "").slice(0, 1).toUpperCase() || "?"}</span>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-o-ink">{item.customer}</p>
            <p className="text-[12px] text-o-faint">{timeAgo(item.since)}</p>
          </div>
        </div>
        <p className="mt-3 text-[15px] font-medium leading-6 text-o-ink">{item.title}</p>
        {fig && <p className="mt-2 text-[22px] font-semibold tracking-tight tabular-nums text-o-ink">{fig}</p>}
        <p className="mt-2 text-[12.5px] leading-5 text-o-muted">{item.why}</p>
      </div>
      <div className="mt-4 flex gap-2">
        {primary && (
          <button type="button" disabled={busy} onClick={() => void act(item, primary.action)} title={primary.consequence} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl bg-o-accent px-4 text-[14px] font-semibold text-white shadow-[0_0_28px_-6px_rgba(91,140,255,0.85)] transition hover:brightness-110 disabled:opacity-50">
            {busy ? "Working…" : primary.action === "approve" ? "Approve" : primary.label}
          </button>
        )}
        <button type="button" onClick={() => onReview(item.id)} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl bg-o-surface px-4 text-[14px] font-semibold text-o-ink ring-1 ring-inset ring-o-line-strong transition hover:ring-o-accent/50">
          Review
        </button>
      </div>
      {primary && <p className="mt-2.5 text-[11.5px] leading-4 text-o-faint">{primary.consequence}</p>}
      {queue.length > 1 && (
        <button type="button" onClick={() => onReview()} className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-o-warn hover:underline">
          {plural(queue.length - 1, "more decision")} waiting <Icon name="chevron" size={14} />
        </button>
      )}
    </section>
  );
}

const money1 = (m: Money) => (hasMoney(m) ? formatMoney(m) : "—");

/** "Your business, in motion" — made / recovered / at risk / pending, with real 7-day trends where they exist. */
export function MotionStrip({ ws, onTab, extra }: { ws: OwnerWorkspace; onTab?: (t: Tab) => void; extra?: React.ReactNode }) {
  const r = ws.revenue;
  const s = ws.opportunities.summary;
  const tr = ws.trend;
  const go = onTab ? () => onTab("money") : undefined;
  return (
    <div className={`grid grid-cols-1 divide-y divide-o-line sm:grid-cols-2 sm:gap-x-6 sm:divide-y-0 ${extra ? "xl:grid-cols-3 2xl:grid-cols-5 2xl:gap-x-0 2xl:divide-x [&>*]:2xl:px-4 [&>*:first-child]:2xl:pl-0" : "lg:grid-cols-4 lg:gap-x-0 lg:divide-x [&>*]:lg:px-4 [&>*:first-child]:lg:pl-0"}`}>
      <MotionStat icon="money" tone="ok" label="Made" value={money1(r.direct)} sub={`${plural(r.directPayments, "verified payment")} ${ws.window.label}`} spark={tr.currency ? <Sparkline values={tr.made} tone="ok" ariaLabel={`Verified ${tr.currency} collected per day, last 7 days`} /> : undefined} onClick={go} />
      <MotionStat icon="pulse" tone="accent" label="Recovered" value={money1(r.recovered)} sub="Paid after an earlier attempt failed" spark={tr.currency ? <Sparkline values={tr.recovered} tone="accent" ariaLabel={`Recovered ${tr.currency} per day, last 7 days`} /> : undefined} onClick={go} />
      <MotionStat icon="clock" tone="violet" label="Pending" value={money1(r.potential)} sub={r.potentialSimulatedItems ? `${formatMoney(r.potentialSimulated)} pending is test money` : `${plural(r.potentialItems, "open link or request", "open links or requests")} — not revenue`} onClick={go} />
      <MotionStat icon="alert" tone={hasMoney(s.atRisk) ? "bad" : "neutral"} label="At risk" value={money1(s.atRisk)} sub={hasMoney(s.atRisk) ? "Likely lost unless someone acts" : "Nothing at risk"} onClick={go} />
      {extra}
    </div>
  );
}

/**
 * BARRY's reply to an owner command — what the command maps to in what BARRY really does. Questions
 * never reach here (they go to Ask BARRY). Nothing here executes; the only buttons are navigation to
 * the real place the owner acts.
 */
export function CommandReply({ cmd, ws, onIntervention, onClose }: { cmd: OwnerCommand; ws: OwnerWorkspace; onIntervention: (id: string) => void; onClose: () => void }) {
  const i = cmd.intent;
  const body = (() => {
    switch (i.kind) {
      case "operation": {
        const rule = i.rule ? `after ${i.rule.afterHours ? `${i.rule.afterHours}h` : "the moment it's due"}, up to ${plural(i.rule.maxAttempts, "attempt")} each` : "";
        if (i.state === "not_in_plan")
          return (
            <>
              <p>Proactive follow-ups aren&apos;t in your plan, so BARRY won&apos;t contact customers about this on its own. Nothing was started.</p>
              <Link href="/owner/settings#plan" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-o-accent hover:underline">See your plan <Icon name="chevron" size={14} /></Link>
            </>
          );
        if (i.state === "off") return <p>Your follow-up rules turn this off, so BARRY doesn&apos;t do it. Nothing was started — the BARRY team can turn the rule on with you.</p>;
        return (
          <>
            <p>
              This already runs under your follow-up rule{rule ? ` — ${rule}` : ""}. BARRY only contacts customers who are already in a conversation with you, inside your limits, and counts a result only when the records verify it.
              {i.live ? " Here it is, live:" : ` Nothing qualifies right now — BARRY starts the moment one appears.`}
            </p>
            {i.live && (
              <div className="mt-4">
                <WorkflowFlow w={i.live} />
              </div>
            )}
          </>
        );
      }
      case "decide": {
        const item = i.interventionId ? ws.interventions.find((x) => x.id === i.interventionId) : undefined;
        return item ? (
          <>
            <p>Decisions are made on the card with the exact terms in front of you — BARRY never approves from a sentence.</p>
            <button type="button" onClick={() => onIntervention(item.id)} className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-o-warn-bg px-3 py-2 text-[13px] font-medium text-o-warn ring-1 ring-inset ring-o-warn-line hover:brightness-110">
              <Icon name="shield" size={14} /> Open the decision: {item.customer}
            </button>
          </>
        ) : (
          <p>{ws.interventions.length ? "Tell me which customer — or open Actions to see every decision waiting." : "Nothing is waiting for your decision right now."}</p>
        );
      }
      case "teach":
        return (
          <>
            <p>That&apos;s a rule. Rules go through Train BARRY: BARRY reads it, you see exactly how it will be applied, and only then does it take effect. Nothing changed yet.</p>
            <Link href={`/owner/train?rule=${encodeURIComponent(cmd.text)}#teach-rule`} className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-o-violet/15 px-3 py-2 text-[13px] font-medium text-o-violet ring-1 ring-inset ring-o-violet/30 hover:brightness-110">
              <Icon name="book" size={14} /> Teach this rule
            </Link>
          </>
        );
      case "unsupported":
        return <p>{i.reason} Nothing was started.</p>;
      default:
        return null;
    }
  })();
  return (
    <div className="o-rise mt-4 flex gap-3" role="status" aria-live="polite">
      <BarryOrb size={30} state={i.kind === "operation" && i.state === "running" && i.live?.open ? "working" : "idle"} />
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-o-surface/80 px-4 py-3.5 text-[14px] leading-6 text-o-ink-2 ring-1 ring-inset ring-o-line">
        <p className="mb-1.5 flex items-center justify-between gap-2 text-[12px] text-o-faint">
          <span className="truncate">“{cmd.text}”</span>
          <button type="button" onClick={onClose} aria-label="Dismiss" className="rounded-md p-1 hover:bg-o-sunken hover:text-o-ink"><Icon name="close" size={14} /></button>
        </p>
        {body}
      </div>
    </div>
  );
}

/** Recorded events, newest first, as a vertical stream — no boxes, a luminous spine. */
export function ActivityStream({ items, onOpen, empty }: { items: ActivityItem[]; onOpen: (conversationId: string) => void; empty: string }) {
  if (items.length === 0) return <p className="text-[13px] leading-6 text-o-muted">{empty}</p>;
  const dot = { ok: "bg-o-ok shadow-[0_0_10px_rgba(61,220,151,0.8)]", accent: "bg-o-accent shadow-[0_0_10px_rgba(91,140,255,0.8)]", violet: "bg-o-violet", warn: "bg-o-warn", bad: "bg-o-bad", neutral: "bg-o-faint" } as const;
  return (
    <ol className="relative">
      <span aria-hidden className="o-vline absolute bottom-2 left-[5px] top-2" />
      {items.map((f) => {
        const inner = (
          <>
            <span aria-hidden className={`absolute left-0 top-[9px] h-[11px] w-[11px] rounded-full ring-[3px] ring-o-canvas ${dot[f.tone]}`} />
            <span className="block truncate text-[13.5px] text-o-ink">{f.text}</span>
            <span className="mt-0.5 flex gap-2 text-[12px] text-o-faint">
              <span className="tabular-nums">{timeAgo(f.at)}</span>
              {f.sub && <span className="truncate">· {f.sub}</span>}
            </span>
          </>
        );
        return (
          <li key={f.id} className="relative">
            {f.conversationId ? (
              <button type="button" onClick={() => onOpen(f.conversationId!)} className="relative block w-full rounded-xl py-2 pl-6 pr-2 text-left transition hover:bg-o-sunken/50">
                {inner}
              </button>
            ) : (
              <div className="relative py-2 pl-6 pr-2">{inner}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
