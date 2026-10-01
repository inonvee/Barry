"use client";

import { useState } from "react";

import Link from "next/link";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { ActivityItem, Workflow } from "@/lib/owner/control-room";
import type { OwnerReply } from "@/lib/owner/command-service";
import { STATE_WORDS, type OwnerOperationView } from "@/lib/owner/operation-model";
import type { InitiativeView } from "@/lib/initiative/model";
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
 * BARRY's reply to an owner command — rendered from the SERVER's reply (the same reply the WhatsApp
 * owner channel sends): text, exact actions (resolved server-side against stored, single-use prompts),
 * links, and the live operation when one was started. Nothing is decided in the browser.
 */
export function CommandReply({ text, reply, busy, onAction, onClose }: { text: string; reply: OwnerReply; busy?: boolean; onAction: (actionId: string) => void; onClose: () => void }) {
  const running = reply.operation && (reply.operation.derivedState === "running" || reply.operation.derivedState === "waiting_on_customers");
  return (
    <div className="o-rise mt-4 flex gap-3" role="status" aria-live="polite">
      <BarryOrb size={30} state={running ? "working" : "idle"} />
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-o-surface/80 px-4 py-3.5 text-[14px] leading-6 text-o-ink-2 ring-1 ring-inset ring-o-line">
        <p className="mb-1.5 flex items-center justify-between gap-2 text-[12px] text-o-faint">
          <span className="truncate">“{text}”</span>
          <button type="button" onClick={onClose} aria-label="Dismiss" className="rounded-md p-1 hover:bg-o-sunken hover:text-o-ink"><Icon name="close" size={14} /></button>
        </p>
        <p className="whitespace-pre-wrap">{reply.text}</p>
        {reply.operation && (
          <div className="mt-4">
            <OperationFlow op={reply.operation} />
          </div>
        )}
        {(reply.actions?.length || reply.links?.length) ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {reply.actions?.map((a) => (
              <button key={a.id} type="button" disabled={busy} onClick={() => onAction(a.id)} className={`inline-flex min-h-10 items-center rounded-xl px-4 text-[13.5px] font-semibold transition disabled:opacity-50 ${/approve|start/i.test(a.title) ? "bg-o-accent text-white hover:brightness-110" : "bg-o-surface text-o-ink ring-1 ring-inset ring-o-line-strong hover:ring-o-accent/50"}`}>
                {a.title}
              </button>
            ))}
            {reply.links?.map((l) => (
              <Link key={l.href} href={l.href} className="inline-flex min-h-10 items-center gap-1 rounded-xl px-3 text-[13px] font-medium text-o-accent hover:underline">
                {l.label} <Icon name="chevron" size={14} />
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const SOURCE_WORDS = { web: "From the command bar", whatsapp: "From WhatsApp", voice: "By voice" } as const;

/** An operation an owner command started, as a live flow: cohort → contacted → replied / purchased (verified). */
export function OperationFlow({ op, text }: { op: OwnerOperationView; text?: string }) {
  const p = op.progress;
  const live = op.derivedState === "running" || op.derivedState === "waiting_on_customers";
  const branches: FlowBranch[] = [
    { label: "Purchased", value: p.purchased, tone: p.purchased ? "ok" : "muted", sub: hasMoney(p.recovered) ? `${formatMoney(p.recovered)} recovered (verified)` : undefined },
    { label: "Replied · still talking", value: p.stillTalking, tone: p.stillTalking ? "accent" : "muted", live: live && p.stillTalking > 0 },
    { label: "Contacted · waiting", value: p.waiting, tone: p.waiting ? "accent" : "muted", live: live && p.waiting > 0 },
    ...(p.excluded ? [{ label: p.alreadyDone ? `Not contacted (${p.alreadyDone} already done)` : "Not contacted", value: p.excluded, tone: "muted" as const }] : []),
    ...(p.failed ? [{ label: "Failed", value: p.failed, tone: "warn" as const }] : []),
  ];
  const stateChip = <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${live ? "bg-o-ok-bg text-o-ok ring-o-ok-line" : op.derivedState === "blocked" || op.derivedState === "failed" ? "bg-o-bad-bg text-o-bad ring-o-bad-line" : "bg-o-neutral-bg text-o-muted ring-o-line"}`}>{STATE_WORDS[op.derivedState]}</span>;
  return (
    <div id={`op-${op.id}`} className="scroll-mt-24">
      <p className="mb-2 flex flex-wrap items-center gap-x-2 text-[11.5px] font-semibold uppercase tracking-[0.16em] text-o-violet">
        <Icon name={op.requestedBy.source === "whatsapp" ? "chat" : "bolt"} size={13} /> Owner command · {SOURCE_WORDS[op.requestedBy.source]}
        {text && <span className="truncate font-normal normal-case tracking-normal text-o-muted">“{text}”</span>}
      </p>
      <LiveFlow icon={FLOW_ICON[op.workflow] ?? "bolt"} title={op.title} state={stateChip} sub={`${op.scope.label} · ${p.contacted} contacted · ${p.replied} replied`} source={p.cohort} sourceLabel="customers found" branches={branches} note={[op.blockedReason, op.stoppedAt ? `Stopped by you — messages already sent stay sent.` : "", p.test ? `${plural(p.test, "customer")} in test mode — never counted as money.` : ""].filter(Boolean).join(" ") || undefined} />
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

/**
 * BARRY NOTICED — one high-signal initiative at a time, only when a scan persisted one with evidence.
 * Nothing renders when there is nothing (the interface stays quiet). "Do this" runs the recommended
 * command through the normal owner command service; it is never a shortcut.
 */
export type InitiativeAct = (id: string, action: "review" | "dismiss" | "snooze" | "act") => Promise<OwnerReply | void>;

export function NoticedCard({ items, onAct, onAsk }: { items: InitiativeView[]; onAct: InitiativeAct; onAsk: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const i = items[0];
  if (!i) return null;
  const run = async (action: Parameters<InitiativeAct>[1]) => {
    setBusy(true);
    try {
      const r = await onAct(i.id, action);
      if (r) setReply(r.text);
    } catch (e) {
      setReply(e instanceof Error ? e.message : "Something went wrong — nothing was changed.");
    } finally {
      setBusy(false);
    }
  };
  const a = i.recommendation.action;
  return (
    <section className="o-panel o-rise rounded-[22px] p-5 ring-1 ring-inset ring-o-violet/25" aria-labelledby="noticed" data-initiative={i.id}>
      <h2 id="noticed" className="flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-[0.18em] text-o-violet">
        <Icon name="spark" size={14} /> BARRY noticed
        <span className="ml-auto text-[11px] font-medium normal-case tracking-normal text-o-faint">{i.importanceWords}</span>
      </h2>
      <p className="mt-2.5 text-[15px] font-semibold leading-6 text-o-ink">{i.title}</p>
      <p className="mt-1 text-[13.5px] leading-6 text-o-ink-2">{i.observation}</p>
      <p className="mt-1.5 text-[11.5px] text-o-faint">{i.basis}{i.testData ? " · test data" : ""}</p>
      {open && (
        <div className="mt-3 rounded-xl bg-o-sunken/70 p-3 text-[13px] leading-6 text-o-ink-2 ring-1 ring-inset ring-o-line">
          <p>{i.recommendation.text}</p>
          {i.impact.note && <p className="mt-1 text-[12px] text-o-faint">{i.impact.note}</p>}
          {i.entitlement === "not_included" && <p className="mt-1 text-[12px] text-o-faint">BARRY can&apos;t do this on your current plan — it&apos;s a recommendation only.</p>}
        </div>
      )}
      {reply && <p className="mt-3 whitespace-pre-wrap rounded-xl bg-o-surface/80 p-3 text-[13px] leading-6 text-o-ink-2 ring-1 ring-inset ring-o-line">{reply}</p>}
      <div className="mt-3.5 flex flex-wrap gap-2">
        {i.canAct && a?.kind === "command" ? (
          <button type="button" disabled={busy} onClick={() => void run("act")} className="inline-flex min-h-9 items-center rounded-xl bg-o-accent px-3.5 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:opacity-50">
            {a.label}
          </button>
        ) : a?.kind === "link" ? (
          <Link href={a.href} className="inline-flex min-h-9 items-center rounded-xl bg-o-surface px-3.5 text-[13px] font-semibold text-o-ink ring-1 ring-inset ring-o-line-strong hover:ring-o-accent/50">
            {a.label}
          </Link>
        ) : null}
        {!open && (
          <button type="button" disabled={busy} onClick={() => { setOpen(true); void run("review"); }} className="inline-flex min-h-9 items-center rounded-xl px-3 text-[13px] font-medium text-o-ink-2 hover:text-o-ink">
            Review
          </button>
        )}
        <button type="button" onClick={onAsk} className="inline-flex min-h-9 items-center rounded-xl px-3 text-[13px] font-medium text-o-ink-2 hover:text-o-ink">
          Ask BARRY
        </button>
        <span className="ml-auto flex gap-1">
          <button type="button" disabled={busy} onClick={() => void run("snooze")} className="rounded-lg px-2 py-1.5 text-[12.5px] text-o-faint hover:text-o-ink">Snooze</button>
          <button type="button" disabled={busy} onClick={() => void run("dismiss")} className="rounded-lg px-2 py-1.5 text-[12.5px] text-o-faint hover:text-o-ink">Dismiss</button>
        </span>
      </div>
      {items.length > 1 && (
        <button type="button" onClick={onAsk} className="mt-2 text-[12.5px] font-medium text-o-violet hover:underline">
          +{items.length - 1} more BARRY noticed
        </button>
      )}
    </section>
  );
}
