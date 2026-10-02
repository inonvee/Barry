"use client";

import type { CSSProperties, ReactNode } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { Money } from "@/lib/owner/revenue";
import { activeWork, proactiveWords, workflows } from "@/lib/owner/control-room";
import { activityTimeline, noticedCard } from "@/lib/owner/os";
import { money } from "@/lib/owner/lang";
import { hasMoney } from "@/lib/format/money";
import { INTERVENTION_KIND } from "@/components/owner/views/shared";

/**
 * TODAY — three art-direction concepts on the same real records. Each is a different idea of what a
 * living business surface is; none uses cards, chips, icon tiles, gradients or a display serif.
 *   A · THE SPINE      time is the layout: the owner's items above "now", BARRY's work AT now, the day below
 *   B · THE BALL       who holds the ball: you · BARRY · customers, each a lane with its real items
 *   C · BARRY SPEAKS   BARRY's own status in plain language, and the day's real pulse as a 24-hour strip
 */

// ── Shared reading of the records ────────────────────────────────────────────────────────────────────

const sumMoney = (a: Money, b: Money): Money => {
  const out: Money = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
};

function useDay(ws: OwnerWorkspace, now: Date) {
  const tz = ws.business.timezone;
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...o });
  const key = (d: Date) => fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const clock = (iso: string | Date) => fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const day = (iso: string) => {
    const k = key(new Date(iso));
    if (k === key(now)) return "Today";
    if (k === key(new Date(now.getTime() - 864e5))) return "Yesterday";
    return fmt({ weekday: "long", day: "numeric", month: "short" }).format(new Date(iso));
  };
  const ago = (iso: string) => {
    const m = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60000));
    if (m < 2) return "now";
    if (m < 60) return `${m}m`;
    if (m < 48 * 60) return `${Math.round(m / 60)}h`;
    return `${Math.round(m / 1440)}d`;
  };
  const needs = ws.interventions;
  const flows = workflows(ws, "en");
  const work = activeWork(ws).map((w) => {
    const flow = flows.find((f) => f.kind === w.workflow);
    const op = w.operationId ? ws.ownerOperations.find((o) => o.id === w.operationId) : undefined;
    const last = op ? op.updatedAt : ws.obligations.filter((o) => o.kind === w.workflow).map((o) => o.updatedAt).sort().at(-1);
    return { id: w.id, title: proactiveWords(w.workflow, "en").title, working: w.state === "working", open: flow?.open ?? w.customers, contacted: flow?.contacted ?? 0, waiting: flow?.waiting ?? 0, noun: flow?.noun ?? "", last };
  });
  const finished = ws.ownerOperations.filter((o) => (o.derivedState === "stopped" || o.derivedState === "completed") && now.getTime() - Date.parse(o.stoppedAt ?? o.updatedAt) < 2 * 864e5);
  const request = (opId: string) => ws.ownerCommands.find((c) => c.operationId === opId && !/^[a-z]:/.test(c.text))?.text;
  const feed = activityTimeline(ws, 80, "en");
  const waitingConvs = ws.conversations.filter((c) => c.status === "waiting_on_customer").sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const r = ws.revenue;
  const s = ws.opportunities.summary;
  const motion = sumMoney(s.waitingOnCustomer, s.stuckWithYou);
  const testItems = s.simulatedItems || r.potentialSimulatedItems;
  return { tz, clock, day, ago, needs, work, finished, request, feed, waitingConvs, r, s, motion, testItems, m: (x: Money) => money("en", x) };
}

const reason = (kind: OwnerWorkspace["interventions"][number]["kind"]) => INTERVENTION_KIND[kind].label.en;

/** A phone frame's bottom navigation, in the concept's own voice. */
function Nav({ style, active = "Today", className = "", activeClass, idleClass }: { style?: CSSProperties; active?: string; className?: string; activeClass: string; idleClass: string }) {
  return (
    <nav className={`fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 pb-[env(safe-area-inset-bottom)] ${className}`} style={style}>
      {["Today", "Ask", "Work", "Money", "More"].map((n) => (
        <span key={n} className={`flex h-[58px] items-center justify-center text-[13.5px] ${n === active ? activeClass : idleClass}`}>{n}</span>
      ))}
    </nav>
  );
}

// ── A · THE SPINE ─────────────────────────────────────────────────────────────────────────────────────
// Time is the layout. One vertical line runs through the page; "now" is a point on it. What waits on the
// owner sits above now (it's blocking what comes next), BARRY's running work is attached AT now, and the
// day flows downward from there. Life = the spine growing at the top as records arrive.

export function ConceptA({ ws, now }: { ws: OwnerWorkspace; now: Date }) {
  const d = useDay(ws, now);
  const ink = "#121417", muted = "#6b7077", faint = "#a2a7ad", line = "#e4e6e9", barry = "#0f766e", you = "#d9541e";
  const past = d.feed.slice(0, 9);
  return (
    <div className="min-h-screen pb-28" style={{ background: "#fafafa", color: ink, fontFamily: "var(--concept-a), system-ui, sans-serif" }}>
      <header className="flex items-center justify-between px-5 pt-5">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: barry }} />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">BARRY</span>
          <span className="text-[14px]" style={{ color: muted }}>Rina Studio</span>
        </div>
        <span className="text-[13px] tabular-nums" style={{ color: muted }}>{d.clock(now)}</span>
      </header>

      <section className="px-5 pt-7">
        <p className="text-[24px] font-semibold leading-[1.2] tracking-[-0.02em]">{d.needs.length ? `${d.needs.length} things need you` : "Nothing needs you"}</p>
        <p className="mt-1 text-[14.5px]" style={{ color: muted }}>
          BARRY is working on {d.work.length} · last activity {d.feed[0] ? d.clock(d.feed[0].at) : "—"}
        </p>
        <div className="mt-4 flex gap-5 text-[13px]" style={{ color: muted }}>
          <span>Made <b className="font-medium tabular-nums" style={{ color: ink }}>{d.m(d.r.direct)}</b></span>
          <span>In motion <b className="font-medium tabular-nums" style={{ color: ink }}>{d.m(d.motion)}</b></span>
          <span>At risk <b className="font-medium tabular-nums" style={{ color: ink }}>{d.m(d.s.atRisk)}</b></span>
        </div>
      </section>

      {/* The spine */}
      <section className="relative mt-7 ps-5 pe-5">
        <span className="absolute bottom-0 top-2 w-px" style={{ background: line, insetInlineStart: 27 }} />

        {/* Above now: blocked on the owner */}
        {d.needs.map((i) => (
          <div key={i.id} className="relative flex gap-4 py-2.5 ps-0">
            <span className="relative z-10 mt-[7px] h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: you, marginInlineStart: 3, boxShadow: `0 0 0 4px #fafafa` }} />
            <div className="min-w-0">
              <p className="text-[15px] font-medium leading-[1.35]">{i.title}</p>
              <p className="text-[13px]" style={{ color: muted }}>waiting {d.ago(i.since)}{i.amount ? ` · ${i.amount}` : ""}</p>
            </div>
          </div>
        ))}

        {/* Now */}
        <div className="relative mt-3 flex items-center gap-3 py-2">
          <span className="relative z-10 h-[15px] w-[15px] shrink-0 rounded-full" style={{ background: barry, boxShadow: "0 0 0 4px #fafafa" }} />
          <span className="text-[12.5px] font-semibold" style={{ color: barry }}>Now · {d.clock(now)}</span>
          <span className="h-px flex-1" style={{ background: barry, opacity: 0.35 }} />
        </div>
        {d.work.map((w) => (
          <div key={w.id} className="relative flex gap-4 py-2.5">
            <span className="relative z-10 mt-[6px] h-[11px] w-[11px] shrink-0 rounded-full" style={{ marginInlineStart: 2, background: w.working ? barry : "#fafafa", border: `2px solid ${barry}`, boxShadow: "0 0 0 4px #fafafa" }} />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-medium leading-[1.35]">{w.title}</p>
              <p className="text-[13px]" style={{ color: muted }}>{w.contacted ? `${w.contacted} of ${w.open} followed up · ${w.waiting} waiting on customers` : `${w.open} open · none followed up yet`}</p>
              <div className="mt-2 h-[3px] w-full" style={{ background: line }}>
                <div className="h-full" style={{ width: `${w.open ? Math.round((w.contacted / w.open) * 100) : 0}%`, background: barry }} />
              </div>
            </div>
          </div>
        ))}

        {/* Below now: the day */}
        <div className="mt-4">
          {past.map((f, k) => {
            const dl = d.day(f.at);
            const head = k === 0 || d.day(past[k - 1].at) !== dl ? dl : null;
            return (
              <div key={f.id}>
                {head && <p className="relative z-10 mb-1 mt-4 w-fit py-0.5 pe-2 text-[12px] font-semibold" style={{ color: faint, background: "#fafafa", marginInlineStart: 0 }}>{head}</p>}
                <div className="relative flex gap-4 py-2">
                  <span className="relative z-10 mt-[8px] h-[5px] w-[5px] shrink-0 rounded-full" style={{ background: faint, marginInlineStart: 5, boxShadow: "0 0 0 4px #fafafa" }} />
                  <span className="w-11 shrink-0 pt-[1px] text-[12.5px] tabular-nums" style={{ color: faint }}>{d.clock(f.at)}</span>
                  <p className="min-w-0 text-[14px] leading-[1.4]" style={{ color: "#3d4248" }}>{f.text}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <Nav className="border-t bg-[#fafafa]" style={{ borderColor: line }} activeClass="font-semibold text-[#121417]" idleClass="text-[#8b9096]" />
    </div>
  );
}

function Lane({ edge, name, count, hint, children }: { edge: string; name: string; count: number; hint: string; children: ReactNode }) {
  return (
    <section className="relative mt-7 ps-[18px]">
      <span className="absolute bottom-1 top-1 w-[4px]" style={{ background: edge, insetInlineStart: 0 }} />
      <div className="flex items-baseline justify-between">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{name} <span className="tabular-nums text-[#6e6e73]">{count}</span></h2>
        <span className="text-[12.5px] text-[#6e6e73]">{hint}</span>
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

const U = ({ children }: { children: ReactNode }) => <span className="underline decoration-1 underline-offset-[3px]" style={{ textDecorationColor: "#b9bec4" }}>{children}</span>;

// ── B · THE BALL ──────────────────────────────────────────────────────────────────────────────────────
// Who holds the ball right now? The page is three lanes — You, BARRY, Customers — each owning its real
// items. Your lane is the only one with colour (a signal-yellow edge); BARRY's work shows its true
// progress; customers' lane is quiet. Life = items moving between lanes as the records change.

export function ConceptB({ ws, now }: { ws: OwnerWorkspace; now: Date }) {
  const d = useDay(ws, now);
  const ink = "#0c0c0d", muted = "#6e6e73", line = "#ececee", you = "#f2b705";
  const latest = d.feed[0];
  return (
    <div className="min-h-screen px-5 pb-28" style={{ background: "#ffffff", color: ink, fontFamily: "var(--concept-b), system-ui, sans-serif" }}>
      <header className="flex items-baseline justify-between pt-5">
        <span className="text-[15px] font-bold tracking-[-0.01em]">Rina Studio</span>
        <span className="text-[13px] tabular-nums" style={{ color: muted }}>Fri · {d.clock(now)}</span>
      </header>
      {latest && (
        <p className="mt-3 flex gap-2 border-y py-2.5 text-[13px] leading-[1.35]" style={{ borderColor: line }}>
          <span className="shrink-0 font-semibold">BARRY</span>
          <span className="shrink-0 tabular-nums" style={{ color: muted }}>{d.clock(latest.at)}</span>
          <span className="min-w-0 truncate" style={{ color: "#3a3a3d" }}>{latest.text.replace(/^BARRY /, "")}</span>
        </p>
      )}

      <Lane edge={you} name="With you" count={d.needs.length} hint={d.needs.length ? `oldest ${d.ago(d.needs.map((i) => i.since).sort()[0])}` : "clear"}>
        {d.needs.map((i) => (
          <div key={i.id} className="flex items-baseline justify-between gap-3 border-b py-2.5 last:border-0" style={{ borderColor: line }}>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-medium">{i.customer}</p>
              <p className="truncate text-[13px]" style={{ color: muted }}>{reason(i.kind)}{i.amount ? ` · ${i.amount}` : ""}</p>
            </div>
            <span className="shrink-0 text-[13px] font-semibold tabular-nums">{d.ago(i.since)}</span>
          </div>
        ))}
      </Lane>

      <Lane edge={ink} name="With BARRY" count={d.work.length} hint={`${d.work.reduce((n, w) => n + w.open, 0)} open items`}>
        {d.work.map((w) => (
          <div key={w.id} className="border-b py-3 last:border-0" style={{ borderColor: line }}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[15px] font-medium">{w.title}</p>
              <span className="shrink-0 text-[13px] tabular-nums" style={{ color: muted }}>{w.contacted}/{w.open}</span>
            </div>
            <div className="mt-2 flex h-[6px] gap-[2px]">
              {Array.from({ length: w.open }, (_, k) => (
                <span key={k} className="flex-1" style={{ background: k < w.contacted ? ink : line }} />
              ))}
            </div>
            <p className="mt-1.5 text-[12.5px]" style={{ color: muted }}>{w.contacted ? `${w.contacted} followed up · ${w.waiting} waiting on the customer` : "none followed up yet"}</p>
          </div>
        ))}
        {d.finished.map((o) => (
          <p key={o.id} className="py-2 text-[13px]" style={{ color: muted }}>Stopped by you {d.day(o.stoppedAt ?? o.updatedAt).toLowerCase()} {d.clock(o.stoppedAt ?? o.updatedAt)} — “{d.request(o.id) ?? proactiveWords(o.workflow, "en").title}”</p>
        ))}
      </Lane>

      <Lane edge="#d4d4d8" name="With customers" count={d.waitingConvs.length} hint="waiting on a reply">
        {d.waitingConvs.slice(0, 4).map((c) => (
          <div key={c.id} className="flex items-baseline justify-between gap-3 py-1.5">
            <p className="min-w-0 truncate text-[14px]" style={{ color: "#3a3a3d" }}>{c.customer}</p>
            <span className="shrink-0 text-[12.5px] tabular-nums" style={{ color: muted }}>{d.ago(c.lastActivityAt)}</span>
          </div>
        ))}
        {d.waitingConvs.length > 4 && <p className="pt-1 text-[12.5px]" style={{ color: muted }}>+{d.waitingConvs.length - 4} more</p>}
      </Lane>

      <p className="mt-8 border-t pt-3 text-[13px] leading-[1.5]" style={{ borderColor: line, color: muted }}>
        Money · made <b className="font-semibold tabular-nums" style={{ color: ink }}>{d.m(d.r.direct)}</b> · in motion <b className="font-semibold tabular-nums" style={{ color: ink }}>{d.m(d.motion)}</b> · at risk <b className="font-semibold tabular-nums" style={{ color: ink }}>{d.m(d.s.atRisk)}</b>
        {d.testItems ? ` · ${d.testItems} test links not counted` : ""}
      </p>

      <Nav className="border-t bg-white" style={{ borderColor: line }} activeClass="font-bold text-[#0c0c0d]" idleClass="text-[#8e8e93]" />
    </div>
  );
}

// ── C · BARRY SPEAKS ──────────────────────────────────────────────────────────────────────────────────
// BARRY is present as a voice: one plain status paragraph, written from the records, that you can tap
// into. Under it, the day's real pulse — every recorded event of the last 24 hours as a mark on a strip
// that ends at now. The rest is the owner's short list and what just happened.

export function ConceptC({ ws, now }: { ws: OwnerWorkspace; now: Date }) {
  const d = useDay(ws, now);
  const ink = "#16181b", muted = "#6a7078", line = "#e3e5e8", barry = "#1d6b4f", bg = "#f4f5f6";
  const handoffs = d.needs.filter((i) => i.kind === "handoff").length;
  const blocked = d.needs.filter((i) => i.kind === "blocked_write").length;
  const others = d.needs.length - handoffs - blocked;
  const parts = [handoffs ? `${handoffs === 1 ? "one customer" : `${handoffs} customers`} asked for a person` : "", blocked ? `${blocked === 1 ? "a checkout" : `${blocked} checkouts`} stopped at the customer's own limit` : "", others ? `${others} more` : ""].filter(Boolean);
  const day = 864e5;
  const events = d.feed.filter((f) => now.getTime() - Date.parse(f.at) <= day);
  const quietSince = events[0] ? d.clock(events[0].at) : null;
  return (
    <div className="min-h-screen px-5 pb-36" style={{ background: bg, color: ink, fontFamily: "var(--concept-c), system-ui, sans-serif" }}>
      <header className="flex items-center justify-between pt-5">
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-[9px] text-[13px] font-bold text-white" style={{ background: barry }}>B</span>
          <div className="leading-tight">
            <p className="text-[14px] font-semibold">BARRY</p>
            <p className="text-[12px]" style={{ color: muted }}>{d.work.length ? "Working" : "Watching"} · Rina Studio</p>
          </div>
        </div>
        <span className="text-[13px] tabular-nums" style={{ color: muted }}>{d.clock(now)}</span>
      </header>

      <p className="mt-6 text-[19px] leading-[1.5] tracking-[-0.01em]">
        {d.needs.length ? <><b className="font-semibold">{d.needs.length} things need you</b> — {parts.join(" and ")}. </> : <b className="font-semibold">Nothing needs you. </b>}
        {d.work.length ? <>I’m {d.work.map((w, k) => <span key={w.id}>{k ? " and " : ""}<U>{w.title.charAt(0).toLowerCase() + w.title.slice(1)}</U> ({w.contacted ? `${w.contacted} of ${w.open} reached` : `${w.open} open, none reached yet`})</span>)}.</> : "I’m watching for work under your rules."}
      </p>

      {/* The day's pulse: real events only, positioned by their time */}
      <section className="mt-6">
        <div className="flex items-baseline justify-between text-[12px]" style={{ color: muted }}>
          <span>Last 24 hours · {events.length} events</span>
          <span>{quietSince ? `quiet since ${quietSince}` : "quiet"}</span>
        </div>
        <svg viewBox="0 0 350 36" className="mt-2 block h-9 w-full" preserveAspectRatio="none" aria-label={`${events.length} recorded events in the last 24 hours`}>
          <line x1="0" y1="30" x2="350" y2="30" stroke={line} strokeWidth="1" />
          {[6, 12, 18].map((h) => <line key={h} x1={(h / 24) * 350} y1="27" x2={(h / 24) * 350} y2="33" stroke={line} strokeWidth="1" />)}
          {events.map((e) => {
            const x = 350 - ((now.getTime() - Date.parse(e.at)) / day) * 350;
            const owner = /^You /.test(e.text);
            return <line key={e.id} x1={x} y1={owner ? 6 : 14} x2={x} y2="30" stroke={owner ? ink : barry} strokeWidth="2" />;
          })}
          <circle cx="346" cy="30" r="3.5" fill={barry} />
        </svg>
        <div className="mt-1 flex justify-between text-[11px] tabular-nums" style={{ color: "#9aa0a6" }}>
          <span>yesterday {d.clock(new Date(now.getTime() - day))}</span>
          <span>now</span>
        </div>
      </section>

      <section className="mt-7">
        <h2 className="text-[13px] font-semibold" style={{ color: muted }}>Needs you</h2>
        <div className="mt-1">
          {d.needs.map((i) => (
            <div key={i.id} className="flex items-center gap-3 border-b py-3 last:border-0" style={{ borderColor: line }}>
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[14px] font-semibold" style={{ background: "#e6e8eb", color: "#4a5058" }}>{i.customer.replace(/[^\p{L}]/gu, "").slice(0, 1).toUpperCase() || "?"}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold">{i.customer}</p>
                <p className="truncate text-[13px]" style={{ color: muted }}>{reason(i.kind)}{i.amount ? ` · ${i.amount}` : ""}</p>
              </div>
              <span className="shrink-0 text-[12.5px] tabular-nums" style={{ color: muted }}>{d.ago(i.since)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-[13px] font-semibold" style={{ color: muted }}>Just happened</h2>
        <div className="mt-1">
          {d.feed.slice(0, 4).map((f) => (
            <div key={f.id} className="flex gap-3 py-2">
              <span className="w-10 shrink-0 pt-[1px] text-[12.5px] tabular-nums" style={{ color: "#9aa0a6" }}>{d.ago(f.at)}</span>
              <p className="min-w-0 text-[14px] leading-[1.4]" style={{ color: "#3c4148" }}>{f.text}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[13px]" style={{ color: muted }}>
          Money: made <b className="font-semibold" style={{ color: ink }}>{d.m(d.r.direct)}</b> · in motion <b className="font-semibold" style={{ color: ink }}>{d.m(d.motion)}</b>
          {hasMoney(d.s.atRisk) ? <> · at risk <b className="font-semibold" style={{ color: ink }}>{d.m(d.s.atRisk)}</b></> : null}
        </p>
        {ws.initiatives[0] && <p className="mt-2 text-[13px]" style={{ color: muted }}>Noticed: {noticedCard(ws.initiatives[0], "en").what}</p>}
      </section>

      {/* Ask, docked above the bar */}
      <div className="fixed inset-x-0 bottom-[58px] z-40 px-4 pb-2 pt-2" style={{ background: bg }}>
        <div className="flex h-11 items-center rounded-[12px] border px-3.5 text-[14.5px]" style={{ borderColor: "#d5d8dc", background: "#fff", color: "#9aa0a6" }}>Tell BARRY what to do…</div>
      </div>
      <Nav className="border-t" style={{ borderColor: line, background: bg }} activeClass="font-semibold text-[#16181b]" idleClass="text-[#8b9198]" />
    </div>
  );
}
