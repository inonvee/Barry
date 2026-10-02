"use client";

import Link from "next/link";
import { useState } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { InitiativeView } from "@/lib/initiative/model";
import { nowWorking, workflows } from "@/lib/owner/control-room";
import { WORK_STATE_WORDS, noticedCard, operationWorkState, type WorkState } from "@/lib/owner/os";
import { Empty, Pill, type Tone } from "../ui";
import { InterventionQueue, type Act } from "../operating";
import { Hero, Icon, LiveDot, Panel, Segmented, StageTitle } from "../kit";
import { DecisionRow } from "./Money";
import { OperationFlow, WorkflowFlow, type InitiativeAct } from "./live";
import { plural } from "./shared";

/**
 * WORK — everything BARRY is doing or noticed, in one vocabulary (New · Watching · Working · Waiting on you
 * · Waiting on customer · Done · Dismissed / snoozed):
 *
 *   NEEDS YOU          decisions and handoffs (the intervention queue — the same records WhatsApp approves)
 *   BARRY IS WORKING   operations the owner started (web or WhatsApp) and the follow-up rules running
 *   BARRY NOTICED      persisted initiatives with evidence; the engine's dedupe / fatigue rules decide what shows
 *
 * Nothing here executes on its own: "Do this" and every decision go through the owner endpoints, which
 * re-check plan, authority and the final-write gate before any effect.
 */

export const WORK_TONE: Record<WorkState, Tone> = { new: "info", watching: "neutral", working: "info", waiting_on_you: "warn", waiting_on_customer: "neutral", done: "good", dismissed: "neutral", snoozed: "neutral" };

export function WorkView({ ws, act, busyId, onOpen, onInitiative, onAsk }: { ws: OwnerWorkspace; act: Act; busyId: string | null; onOpen: (id: string) => void; onInitiative: InitiativeAct; onAsk: (q: string) => void }) {
  const [decisions, setDecisions] = useState<"open" | "decided">("open");
  const [noticedView, setNoticedView] = useState<"open" | "history">("open");
  const queue = ws.interventions;
  const decided = ws.approvals.filter((a) => !(a.actionable || a.lifecycle === "held"));
  const ops = ws.ownerOperations;
  const flows = workflows(ws).sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || b.open - a.open);
  const lines = nowWorking(ws).filter((l) => l.id !== "needs_you");
  const working = ops.filter((o) => operationWorkState(o.derivedState) === "working" || operationWorkState(o.derivedState) === "waiting_on_customer").length + flows.filter((f) => f.state === "running" && f.open > 0).length;
  const history = ws.initiativeHistory ?? [];
  const noticed = noticedView === "open" ? ws.initiatives : history;

  return (
    <div className="flex flex-col gap-8 md:gap-10">
      <Hero
        eyebrow={`Work · ${ws.business.name}`}
        title={queue.length ? <><span className="o-hero-type">{plural(queue.length, "decision")}</span> waiting for you.</> : <>Nothing waits on <span className="o-hero-type">your decision.</span></>}
        lead={`${working ? `BARRY is working on ${plural(working, "thing")}` : "Nothing is running right now"}${ws.initiatives.length ? ` · ${plural(ws.initiatives.length, "thing")} BARRY noticed` : ""}. Approving never skips a re-check; nothing here acts on its own.`}
      />

      {/* NEEDS YOU */}
      <section aria-labelledby="needs-you-h" id="needs-you" className="scroll-mt-24">
        <StageTitle right={<Segmented ariaLabel="Decisions" value={decisions} onChange={setDecisions} options={[{ id: "open", label: "Waiting", count: queue.length }, { id: "decided", label: "Decided", count: decided.length }]} />}>
          <span id="needs-you-h">Needs you</span>
        </StageTitle>
        <div className="mt-4">
          {decisions === "open" ? (
            <InterventionQueue items={queue} busyId={busyId} onAct={act} />
          ) : decided.length === 0 ? (
            <Empty>No decisions yet.</Empty>
          ) : (
            <ul className="divide-y divide-o-line">
              {decided.map((a) => (
                <DecisionRow key={a.id} a={a} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* BARRY IS WORKING */}
      <section className="o-stage p-5 md:p-7" aria-labelledby="working-h" id="working">
        <StageTitle live={working ? "live" : "off"} liveLabel={working ? "Live now" : "Quiet"}>
          <span id="working-h">BARRY is working</span>
        </StageTitle>
        {lines.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
            {lines.map((l) => (
              <li key={l.id} className="flex items-center gap-2 text-[14px] text-o-ink-2">
                <LiveDot state={l.state === "working" ? "working" : l.state === "blocked" ? "attention" : "waiting"} />
                {l.text}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-6 flex flex-col gap-8">
          {ops.map((o) => {
            const s = operationWorkState(o.derivedState);
            return (
              <div key={o.id}>
                <p className="mb-2"><Pill tone={WORK_TONE[s]}>{WORK_STATE_WORDS[s]}</Pill></p>
                <OperationFlow op={o} text={ws.ownerCommands.find((c) => c.operationId === o.id)?.text} />
                <div className="o-hairline mt-8" />
              </div>
            );
          })}
          {flows.map((f, i) => (
            <div key={f.kind}>
              {i > 0 && <div className="o-hairline mb-8" />}
              <WorkflowFlow w={f} />
            </div>
          ))}
          {ops.length === 0 && flows.length === 0 && (
            <p className="text-[13.5px] leading-6 text-o-muted">Nothing running. When a payment link goes unpaid or a checkout is left behind, BARRY follows up under your rules — or ask it to (“Recover abandoned checkouts”) here or on WhatsApp, and you&apos;ll watch it here.</p>
          )}
        </div>
      </section>

      {/* BARRY NOTICED */}
      <section aria-labelledby="noticed-h" id="noticed" className="scroll-mt-24">
        <StageTitle right={<Segmented ariaLabel="BARRY noticed" value={noticedView} onChange={setNoticedView} options={[{ id: "open", label: "Open", count: ws.initiatives.length }, { id: "history", label: "Done & dismissed", count: history.length }]} />}>
          <span id="noticed-h">BARRY noticed</span>
        </StageTitle>
        <p className="mt-1.5 text-[13px] text-o-muted">Things BARRY spotted in your own records, with the evidence. A few at a time — BARRY stays quiet when there is nothing worth your attention.</p>
        <div className="mt-4 flex flex-col gap-3">
          {noticed.length === 0 ? (
            <Empty>{noticedView === "open" ? "Nothing new. BARRY looks over your records a few times a day and only speaks up with evidence." : "Nothing done or dismissed in the last two weeks."}</Empty>
          ) : (
            noticed.map((i) => <NoticedRow key={i.id} i={i} onAct={onInitiative} onAsk={onAsk} />)
          )}
        </div>
      </section>
    </div>
  );
}

/** One "BARRY noticed" item: every owner question answered; actions only while it is open. */
export function NoticedRow({ i, onAct, onAsk }: { i: InitiativeView; onAct: InitiativeAct; onAsk: (q: string) => void }) {
  const c = noticedCard(i);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const live = c.state === "new" || c.state === "watching" || c.state === "working";
  const a = i.recommendation.action;
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
  return (
    <Panel className="p-4 md:p-5" id={`noticed-${i.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={WORK_TONE[c.state]}>{c.stateWords}</Pill>
        <span className="text-[12px] text-o-faint">{i.importanceWords}{c.testData ? " · test data" : ""}</span>
      </div>
      <button type="button" className="mt-2 block w-full text-left" onClick={() => { setOpen((v) => !v); if (!open && c.state === "new") void run("review"); }} aria-expanded={open}>
        <span className="block text-[15px] font-semibold leading-6 text-o-ink">{c.what}</span>
        <span className="mt-1 block text-[13.5px] leading-6 text-o-ink-2">{c.observation}</span>
        <span className="mt-1 inline-flex items-center gap-1 text-[12.5px] font-medium text-o-accent">{open ? "Less" : "Why it matters, evidence, next step"} <Icon name="chevron" size={13} className={open ? "-rotate-90" : "rotate-90"} /></span>
      </button>
      {open && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2.5 rounded-xl bg-o-sunken/60 p-3.5 text-[13px] ring-1 ring-inset ring-o-line sm:grid-cols-[9rem_1fr]">
          {([
            ["Why it matters", c.whyItMatters],
            ["Evidence", c.evidence],
            ["How sure", c.confidence],
            ["Money involved", c.money],
            ["Next step", c.next],
            ["Can BARRY act?", c.canActWords],
            ["Who decides", c.approval],
            ["Being handled", c.handling],
            ["Result", c.result],
          ] as [string, string | null][]).filter(([, v]) => v).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-o-muted">{k}</dt>
              <dd className="break-words text-o-ink-2">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {reply && <p className="mt-3 whitespace-pre-wrap rounded-xl bg-o-surface/80 p-3 text-[13px] leading-6 text-o-ink-2 ring-1 ring-inset ring-o-line">{reply}</p>}
      {live && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {c.canAct && a?.kind === "command" ? (
            <button type="button" disabled={busy} onClick={() => void run("act")} className="inline-flex min-h-10 items-center rounded-xl bg-o-accent px-3.5 text-[13.5px] font-semibold text-white transition hover:brightness-110 disabled:opacity-50">{a.label}</button>
          ) : a?.kind === "link" ? (
            <Link href={a.href} className="inline-flex min-h-10 items-center rounded-xl bg-o-surface px-3.5 text-[13.5px] font-semibold text-o-ink ring-1 ring-inset ring-o-line-strong hover:ring-o-accent/50">{a.label}</Link>
          ) : null}
          <button type="button" onClick={() => onAsk(`Tell me more about: ${i.title}`)} className="inline-flex min-h-10 items-center rounded-xl px-3 text-[13px] font-medium text-o-ink-2 hover:text-o-ink">Ask BARRY</button>
          <span className="ml-auto flex gap-1">
            <button type="button" disabled={busy} onClick={() => void run("snooze")} className="min-h-10 rounded-lg px-2.5 text-[12.5px] text-o-muted hover:text-o-ink">Snooze a week</button>
            <button type="button" disabled={busy} onClick={() => void run("dismiss")} className="min-h-10 rounded-lg px-2.5 text-[12.5px] text-o-muted hover:text-o-ink">Dismiss</button>
          </span>
        </div>
      )}
    </Panel>
  );
}
