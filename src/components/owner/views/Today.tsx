"use client";

import Link from "next/link";
import { useState } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import { activityByHour, activityFeed, nowWorking, workflows } from "@/lib/owner/control-room";
import { ownerPresence, PRESENCE_WORD } from "@/lib/owner/presence-model";
import { commandSuggestions } from "@/lib/owner/command";
import type { OwnerReply } from "@/lib/owner/command-service";
import { hasMoney } from "@/lib/format/money";
import { formatMoney, StateNotice } from "../ui";
import type { Act } from "../operating";
import { BarryOrb, Bars, CommandBar, HeaderLink, Icon, LiveDot, StageTitle, type IconName } from "../kit";
import { WhatsAppCard } from "../OwnerShell";
import { ActivityStream, CommandReply, MotionStrip, NeedsYouFloat, NoticedCard, OperationFlow, WorkflowFlow, type InitiativeAct } from "./live";
import { greeting, plural, type Tab } from "./shared";

/**
 * TODAY — a living story, not a grid. What BARRY did ("BARRY made ₪X today"), what he is doing ("He's
 * working on 3 things"), what needs the owner ("One needs you"), and the business in motion. The
 * owner directs BARRY from the command bar. Every figure comes from the workspace read model.
 */

const WORDS = ["Nothing", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const count = (n: number) => WORDS[n] ?? String(n);

const SUGGESTION_ICON: Record<string, IconName> = { "Who needs me?": "shield", "Recover abandoned checkouts": "cart", "Follow up unpaid payment links": "money", "What are you working on?": "pulse", "How much did we make today?": "receipt" };

/** The command bar's round trip: the SAME owner command service the WhatsApp channel uses. */
export type RunCommand = (body: { text?: string; actionId?: string }) => Promise<OwnerReply>;

/** The three story lines, from the records. */
export function todayStory(ws: OwnerWorkspace) {
  const t = ws.today;
  const made = ws.revenue.direct;
  const did = hasMoney(made)
    ? { lead: "BARRY made ", figure: formatMoney(made), tail: ` ${ws.window.label}.` }
    : t.handledAutonomously
      ? { lead: "BARRY handled ", figure: plural(t.handledAutonomously, "conversation"), tail: ` ${ws.window.label}.` }
      : t.conversations
        ? { lead: "BARRY talked with ", figure: plural(t.conversations, "customer"), tail: ` ${ws.window.label}.` }
        : { lead: "BARRY is ready ", figure: "", tail: "and watching." };
  const lines = nowWorking(ws);
  const live = ws.conversations.filter((c) => c.status === "in_progress").length;
  const things = lines.filter((l) => l.state === "working" || l.state === "waiting").reduce((s, l) => s + l.count, 0) + live;
  const needs = ws.interventions.length;
  const working = things ? `He's working on ${plural(things, "thing")}.` : "Nothing open right now.";
  const needLine = needs ? `${count(needs)} need${needs === 1 ? "s" : ""} you.` : things ? "Nothing needs you." : "He's watching for the next customer.";
  return { did, working: `${working} ${needLine}`, things, needs };
}

export function TodayView({ ws, act, busyId, loading, onOpen, onIntervention, onTab, onCommand, onInitiative }: { ws: OwnerWorkspace; act: Act; busyId: string | null; loading: boolean; onOpen: (id: string) => void; onIntervention: (id?: string) => void; onTab: (t: Tab) => void; onCommand?: RunCommand; onInitiative?: InitiativeAct }) {
  const [text, setText] = useState("");
  const [exchange, setExchange] = useState<{ text: string; reply: OwnerReply } | null>(null);
  const [sending, setSending] = useState(false);
  const ai = ws.health.ai;
  const presence = ownerPresence(ws);
  const story = todayStory(ws);
  const lines = nowWorking(ws).filter((l) => l.id !== "needs_you");
  const feed = activityFeed(ws, 7);
  const flows = workflows(ws).sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || b.open - a.open);
  const hours = activityByHour(ws);
  const setupSteps = ws.capabilities.steps.filter((s) => s.gate !== "customer_traffic").slice(0, 2);
  const liveState = lines.some((l) => l.state === "working") ? "live" : lines.length ? "waiting" : "off";

  const send = async (body: { text?: string; actionId?: string }, label: string) => {
    if (!onCommand) return;
    setSending(true);
    try {
      setExchange({ text: label, reply: await onCommand(body) });
    } catch (e) {
      setExchange({ text: label, reply: { text: e instanceof Error ? e.message : "Something went wrong — nothing was changed.", intent: "unsupported" } });
    } finally {
      setSending(false);
    }
  };
  const submit = (value: string) => {
    setText("");
    void send({ text: value }, value);
  };
  const ownerOps = ws.ownerOperations.filter((o) => o.derivedState !== "blocked" && (o.derivedState === "running" || o.derivedState === "waiting_on_customers" || o.derivedState === "proposed" || Date.parse(o.updatedAt) >= Date.parse(ws.window.since)));
  const commandText = (id: string) => ws.ownerCommands.find((c) => c.operationId === id)?.text;

  const ownerOpsShown = ownerOps.slice(0, 1);
  const flowsShown = ownerOpsShown.length ? [] : flows.slice(0, 1);
  const moreWork = ownerOps.length - ownerOpsShown.length + flows.length - flowsShown.length;

  // The story, in order: presence → what needs you → what BARRY is working on → what changed → money in
  // motion → what BARRY noticed → ask. Each part shows the essentials; the rest is one tap away.
  return (
    <div className="flex flex-col gap-8 md:gap-10">
      {/* Presence: the story so far */}
      <section className="o-rise relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 pt-1 lg:gap-10">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-o-muted">{ws.business.name}</p>
          <h1 className="mt-2 text-[34px] font-semibold leading-[1.02] tracking-[-0.03em] text-o-ink md:text-[52px] xl:text-[58px]">
            {greeting()}, <span className="o-hero-type">{ws.business.name}.</span>
          </h1>
          <p className="mt-3 text-[21px] font-semibold leading-tight tracking-tight text-o-ink md:mt-4 md:text-[30px]">
            {story.did.lead}
            {story.did.figure && <span className="o-hero-type">{story.did.figure}</span>}
            {story.did.tail}
          </p>
          <p className="mt-2 text-[16px] leading-snug text-o-ink-2 md:text-[20px]">
            {story.working}
            {loading && <span className="ml-2 text-[13px] text-o-faint">Refreshing…</span>}
          </p>
        </div>
        <div className="flex flex-col items-center gap-3 self-start pt-2 md:self-center md:pt-0">
          <span className="md:hidden"><BarryOrb size={76} state={presence.state} label={`BARRY · ${PRESENCE_WORD[presence.state]}`} /></span>
          <span className="hidden md:inline-flex"><BarryOrb size={150} state={presence.state} label={`BARRY · ${PRESENCE_WORD[presence.state]}`} /></span>
          <p className="hidden max-w-[14rem] text-center text-[12.5px] leading-5 text-o-muted md:block">
            <span className="font-semibold text-o-ink-2">{PRESENCE_WORD[presence.state]}</span> · {presence.text}
          </p>
        </div>
      </section>

      {(ai.status === "unavailable" || ai.status === "degraded") && (
        <StateNotice tone={ai.status === "unavailable" ? "bad" : "warn"} title={ai.status === "unavailable" ? "BARRY can't understand customers right now" : "BARRY had trouble understanding some messages"}>
          {ai.summary}
        </StateNotice>
      )}

      {/* What needs you, then what BARRY is working on */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(18rem,1fr)]">
        <aside className="order-1 lg:sticky lg:top-20 lg:order-2">
          <NeedsYouFloat ws={ws} act={act} busyId={busyId} onReview={(id) => onIntervention(id)} />
        </aside>
        <section className="o-stage order-2 p-5 md:p-7 lg:order-1" aria-labelledby="working">
          <StageTitle live={liveState} liveLabel={liveState === "live" ? "Live now" : liveState === "waiting" ? "Waiting on customers" : "Quiet"} right={<HeaderLink onClick={() => onTab("work")}>All work</HeaderLink>}>
            <span id="working">BARRY is working</span>
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
            {ownerOpsShown.map((o) => (
              <OperationFlow key={o.id} op={o} text={commandText(o.id)} />
            ))}
            {flowsShown.map((f) => (
              <WorkflowFlow key={f.kind} w={f} />
            ))}
            {ownerOpsShown.length === 0 && flowsShown.length === 0 && (
              <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div>
                  <p className="text-[15px] font-medium text-o-ink">No follow-ups running yet.</p>
                  <p className="mt-1.5 text-[13.5px] leading-6 text-o-muted">When a payment link goes unpaid, a checkout is left behind or a deposit is missing, BARRY follows up under your rules — and you&apos;ll watch it here: who BARRY reached, who paid, who is still talking.</p>
                </div>
                <WhatsAppCard channels={ws.channels} wide />
              </div>
            )}
            {moreWork > 0 && (
              <button type="button" onClick={() => onTab("work")} className="w-fit text-[13px] font-medium text-o-accent hover:underline">+ {plural(moreWork, "more thing")} in Work ›</button>
            )}
          </div>
        </section>
      </div>

      {/* What changed / finished */}
      <section aria-labelledby="happened">
        <StageTitle right={<HeaderLink onClick={() => onTab("activity")}>All activity</HeaderLink>}>
          <span id="happened">Just happened</span>
        </StageTitle>
        <div className="mt-3">
          <ActivityStream items={feed} onOpen={onOpen} empty="Payments, follow-ups, approvals and handoffs appear here the moment BARRY records them." />
        </div>
        {hours.values.some((v) => v > 0) && (
          <div className="mt-6">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-o-faint">Conversations today, by hour</p>
            <Bars values={hours.values} labels={hours.labels} ariaLabel="Conversation activity by hour today" height={40} />
          </div>
        )}
      </section>

      {/* Money in motion */}
      <section aria-labelledby="motion">
        <StageTitle right={<HeaderLink onClick={() => onTab("money")}>Money</HeaderLink>}>
          <span id="motion" className="normal-case tracking-normal text-[17px] text-o-ink">Your business, in motion</span>
        </StageTitle>
        <div className="o-stage mt-3 px-4 py-1 md:px-6">
          <MotionStrip ws={ws} onTab={onTab} />
        </div>
      </section>

      {/* What BARRY noticed */}
      {onInitiative && ws.initiatives.length > 0 && <NoticedCard items={ws.initiatives} onAct={onInitiative} onAsk={() => onTab("work")} />}

      {/* Ask / direct BARRY — the same command service as WhatsApp */}
      <section aria-label="Tell BARRY what to do">
        <CommandBar
          value={text}
          onChange={setText}
          onSubmit={submit}
          busy={sending}
          state={presence.state}
          suggestions={commandSuggestions(ws).map((s) => ({ text: s, icon: SUGGESTION_ICON[s] ?? "spark" }))}
          onSuggestion={submit}
        />
        {exchange && <CommandReply text={exchange.text} reply={exchange.reply} busy={sending} onAction={(id) => void send({ actionId: id }, exchange.text)} onClose={() => setExchange(null)} />}
      </section>

      {setupSteps.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-o-muted">
          <Icon name="lock" size={14} className="text-o-violet" />
          <span className="text-o-ink-2">Unlock next:</span>
          {setupSteps.map((s, i) => (
            <span key={s.id}>
              {s.title} → {s.unlocks.slice(0, 2).join(", ")}
              {i < setupSteps.length - 1 ? " ·" : ""}
            </span>
          ))}
          <Link href="/owner/setup" className="font-medium text-o-accent hover:underline">BARRY setup</Link>
        </p>
      )}
    </div>
  );
}
