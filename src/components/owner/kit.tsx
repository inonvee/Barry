"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import type { PresenceState } from "@/lib/owner/presence-model";

/**
 * THE OWNER CONTROL-ROOM KIT — reusable visual primitives built on the `o-*` tokens: icons, BARRY's
 * orb, live presence, dimensional panels, big numbers, real-data bars, the signature
 * COMMAND → BARRY → OUTCOME flow and activity rows. Nothing here invents data: every component renders
 * exactly what it is given, and says so when there is nothing.
 */

// ── Icons (stroke, 24px grid, currentColor) ──────────────────────────────────────────────────────

const PATHS = {
  today: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1Z" /></>,
  money: <><circle cx="12" cy="12" r="9" /><path d="M15 9.3c-.6-.8-1.7-1.3-3-1.3-1.7 0-3 .9-3 2s1.3 1.7 3 2 3 .9 3 2-1.3 2-3 2c-1.3 0-2.4-.5-3-1.3M12 6.5v1.5M12 16v1.5" /></>,
  barry: <><circle cx="12" cy="12" r="9" /><circle cx="9.3" cy="11" r="1.1" fill="currentColor" /><circle cx="14.7" cy="11" r="1.1" fill="currentColor" /><path d="M9 15c1.7 1.2 4.3 1.2 6 0" /></>,
  more: <><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></>,
  check: <path d="m5 12.5 4.2 4.2L19 7" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  back: <path d="m15 6-6 6 6 6" />,
  chat: <><path d="M21 11.5a8.4 8.4 0 0 1-12.2 7.5L3 21l2-5.6A8.4 8.4 0 1 1 21 11.5Z" /><path d="M8.5 10h7M8.5 13.5h4.5" /></>,
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.7 2.6 3 5.2" /></>,
  cart: <><circle cx="9" cy="20" r="1.3" /><circle cx="18" cy="20" r="1.3" /><path d="M2 3h2.5l2.7 12.4a1.5 1.5 0 0 0 1.5 1.1h9.6a1.5 1.5 0 0 0 1.4-1.1L22 8H6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  alert: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>,
  book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14Z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" /></>,
  plug: <><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8ZM12 18v4" /></>,
  card: <><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M2.5 10h19M6 15h4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  pulse: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  send: <><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="M22 2 11 13" /></>,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />,
  flag: <><path d="M4 22V4M4 4h12l-2 4 2 4H4" /></>,
  lock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  receipt: <><path d="M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2V2Z" /><path d="M9 7h6M9 11h6M9 15h4" /></>,
  phone: <><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M11 18h2" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className = "" }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`}>
      {PATHS[name]}
    </svg>
  );
}

/** A soft icon tile (the colored square that anchors a metric or row). */
export function IconTile({ name, tone = "accent", size = 36 }: { name: IconName; tone?: "accent" | "violet" | "ok" | "warn" | "bad" | "neutral"; size?: number }) {
  const t = { accent: "bg-o-accent/15 text-o-accent ring-o-accent/25", violet: "bg-o-violet/15 text-o-violet ring-o-violet/25", ok: "bg-o-ok-bg text-o-ok ring-o-ok-line", warn: "bg-o-warn-bg text-o-warn ring-o-warn-line", bad: "bg-o-bad-bg text-o-bad ring-o-bad-line", neutral: "bg-o-neutral-bg text-o-neutral ring-o-neutral-line" }[tone];
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ${t}`} style={{ width: size, height: size }}>
      <Icon name={name} size={Math.round(size * 0.5)} />
    </span>
  );
}

// ── BARRY's presence ─────────────────────────────────────────────────────────────────────────────

const ORB: Record<PresenceState, { c1: string; c2: string; eye: string; spin: boolean; halo: "fast" | "slow" | "none" }> = {
  working: { c1: "#5b8cff", c2: "#9b7bff", eye: "#cfe4ff", spin: true, halo: "fast" },
  needs_you: { c1: "#f6b54a", c2: "#5b8cff", eye: "#ffe9c4", spin: true, halo: "fast" },
  completed: { c1: "#3ddc97", c2: "#5b8cff", eye: "#d4fff0", spin: false, halo: "fast" },
  waiting: { c1: "#4a6bd1", c2: "#6d5bd0", eye: "#b7c9f5", spin: false, halo: "slow" },
  idle: { c1: "#4a6bd1", c2: "#6d5bd0", eye: "#b7c9f5", spin: false, halo: "slow" },
  degraded: { c1: "#f6b54a", c2: "#ff7a7a", eye: "#ffd9b0", spin: false, halo: "slow" },
  unavailable: { c1: "#ff7a7a", c2: "#5f6884", eye: "#5f6884", spin: false, halo: "none" },
  paused: { c1: "#5f6884", c2: "#3a4361", eye: "#5f6884", spin: false, halo: "none" },
};

/**
 * BARRY'S PRESENCE — the visual representation of the intelligence running the business. Its state
 * comes from ownerPresence() (real records): the ring turns only while BARRY has open work or a
 * decision waits, the halo breathes slowly while waiting, and it dims when BARRY is unavailable.
 */
export function BarryOrb({ size = 36, state = "idle", label }: { size?: number; state?: PresenceState; label?: string }) {
  const o = ORB[state];
  const ring = Math.max(1.5, size * 0.03);
  return (
    <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      {o.halo !== "none" && <span className={`absolute rounded-full ${o.halo === "fast" ? "o-orb-halo" : "o-orb-halo-slow"}`} style={{ inset: -size * 0.28, background: `radial-gradient(circle, ${o.c1}88 0%, ${o.c2}33 38%, transparent 68%)` }} />}
      <span
        className={`absolute inset-0 rounded-full ${o.spin ? "o-orb-spin" : ""}`}
        style={{
          background: `conic-gradient(from 200deg, transparent 0deg, ${o.c1} 70deg, ${o.c2} 150deg, transparent 230deg, ${o.c1}66 300deg, transparent 360deg)`,
          WebkitMask: `radial-gradient(farthest-side, transparent calc(100% - ${ring + 1}px), #000 calc(100% - ${ring}px))`,
          mask: `radial-gradient(farthest-side, transparent calc(100% - ${ring + 1}px), #000 calc(100% - ${ring}px))`,
        }}
      />
      <span
        className="absolute rounded-full"
        style={{
          inset: size * 0.07,
          background: "radial-gradient(circle at 36% 26%, #2b3672 0%, #0e1436 52%, #05071a 100%)",
          boxShadow: `inset 0 0 0 ${Math.max(1, size * 0.012)}px ${o.c1}99, inset 0 ${-size * 0.08}px ${size * 0.2}px ${o.c1}55, 0 0 ${size * 0.35}px ${o.c1}55`,
        }}
      />
      <span className="absolute flex items-center" style={{ gap: size * 0.13, top: size * 0.4 }}>
        {[0, 1].map((i) => (
          <span key={i} className={state === "unavailable" || state === "paused" ? "" : "o-orb-eye"} style={{ width: size * 0.105, height: size * 0.16, borderRadius: size, background: o.eye, boxShadow: `0 0 ${size * 0.09}px ${o.eye}, 0 0 ${size * 0.2}px ${o.c1}` }} />
        ))}
      </span>
    </span>
  );
}

/** Small orb (brand, avatars). `alive` = BARRY is actually working (real state), never decoration. */
export function Orb({ size = 36, alive = true }: { size?: number; alive?: boolean }) {
  return <BarryOrb size={size} state={alive ? "working" : "idle"} />;
}

export type LiveState = "live" | "working" | "waiting" | "attention" | "off";

/** A small state dot. Pulses only for live / working (real activity), steady otherwise. */
export function LiveDot({ state = "live" }: { state?: LiveState }) {
  const c = { live: "bg-o-ok text-o-ok", working: "bg-o-accent text-o-accent", waiting: "bg-o-faint text-o-faint", attention: "bg-o-warn text-o-warn", off: "bg-o-faint text-o-faint" }[state];
  return <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${c} ${state === "live" || state === "working" ? "o-live-dot" : ""}`} />;
}

// ── Surfaces & type ──────────────────────────────────────────────────────────────────────────────

export function Panel({ children, className = "", glow, as: As = "section", id }: { children: ReactNode; className?: string; glow?: boolean; as?: "section" | "div" | "article" | "li"; id?: string }) {
  return (
    <As id={id} className={`o-panel o-rise rounded-2xl ${glow ? "shadow-o-glow" : ""} ${className}`}>
      {children}
    </As>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-o-muted">{children}</p>;
}

/** A panel header: optional icon tile, title, one-line context, a right-side link/action. */
export function PanelHeader({ icon, tone, title, sub, right, live }: { icon?: IconName; tone?: Parameters<typeof IconTile>[0]["tone"]; title: ReactNode; sub?: ReactNode; right?: ReactNode; live?: LiveState }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {icon && <IconTile name={icon} tone={tone} />}
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-o-ink">
            {title}
            {live && <LiveDot state={live} />}
          </h2>
          {sub && <p className="mt-0.5 text-[13px] leading-5 text-o-muted">{sub}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

/** A link-styled header action ("All money ›"). */
export function HeaderLink({ href, onClick, children }: { href?: string; onClick?: () => void; children: ReactNode }) {
  const cls = "inline-flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-1 text-[13px] font-medium text-o-muted transition hover:bg-o-sunken hover:text-o-ink";
  return href ? (
    <Link href={href} className={cls}>
      {children}
      <Icon name="chevron" size={14} />
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {children}
      <Icon name="chevron" size={14} />
    </button>
  );
}

/** A big number with its meaning. `value` is pre-formatted by the caller from real data. */
export function BigMetric({ label, value, sub, tone = "ink", icon, iconTone, href, onClick }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "ink" | "ok" | "warn" | "bad" | "accent"; icon?: IconName; iconTone?: Parameters<typeof IconTile>[0]["tone"]; href?: string; onClick?: () => void }) {
  const color = { ink: "text-o-ink", ok: "text-o-ok", warn: "text-o-warn", bad: "text-o-bad", accent: "text-o-accent" }[tone];
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2.5 text-[13px] font-medium text-o-ink-2">
          {icon && <IconTile name={icon} tone={iconTone} size={30} />}
          {label}
        </span>
        {(href || onClick) && <Icon name="chevron" size={16} className="text-o-faint" />}
      </div>
      <p className={`mt-3 text-[30px] font-semibold leading-none tracking-tight tabular-nums md:text-[34px] ${color}`}>{value}</p>
      {sub && <p className="mt-2 text-[12.5px] leading-5 text-o-muted">{sub}</p>}
    </>
  );
  const cls = "o-panel o-rise block rounded-2xl p-4 text-left transition md:p-5";
  if (href) return <Link href={href} className={`${cls} hover:shadow-o-glow`}>{inner}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className={`${cls} w-full hover:shadow-o-glow`}>{inner}</button>;
  return <div className={cls}>{inner}</div>;
}

/**
 * Real-data bars (e.g. conversations per hour). Renders only what it is given; with no data it draws
 * nothing — never a decorative wave.
 */
export function Bars({ values, labels, tone = "accent", height = 56, ariaLabel }: { values: number[]; labels?: string[]; tone?: "accent" | "ok" | "violet"; height?: number; ariaLabel: string }) {
  const max = Math.max(...values, 0);
  if (max === 0) return null;
  const color = { accent: "bg-o-accent", ok: "bg-o-ok", violet: "bg-o-violet" }[tone];
  return (
    <div role="img" aria-label={ariaLabel} className="flex items-end gap-1" style={{ height }}>
      {values.map((v, i) => (
        <span key={i} title={labels ? `${labels[i]}: ${v}` : String(v)} className={`flex-1 rounded-t-[3px] ${v ? color : "bg-o-line"} transition-all`} style={{ height: `${Math.max(v ? 10 : 4, (v / max) * 100)}%`, opacity: v ? 0.35 + 0.65 * (v / max) : 1 }} />
      ))}
    </div>
  );
}

/** A segmented share bar (e.g. handled vs needed you). */
export function ShareBar({ parts, ariaLabel }: { parts: { value: number; tone: "ok" | "accent" | "warn" | "bad" | "neutral"; label: string }[]; ariaLabel: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (total === 0) return null;
  const bg = { ok: "bg-o-ok", accent: "bg-o-accent", warn: "bg-o-warn", bad: "bg-o-bad", neutral: "bg-o-faint" };
  return (
    <div>
      <div role="img" aria-label={ariaLabel} className="flex h-2 overflow-hidden rounded-full bg-o-sunken">
        {parts.filter((p) => p.value > 0).map((p) => (
          <span key={p.label} className={bg[p.tone]} style={{ width: `${(p.value / total) * 100}%` }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-o-muted">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${bg[p.tone]}`} />
            {p.label} <span className="font-semibold tabular-nums text-o-ink">{p.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── COMMAND → BARRY → OUTCOME ────────────────────────────────────────────────────────────────────

export type FlowStage = { label: string; value: string | number; tone?: "ink" | "ok" | "warn" | "muted" };

/**
 * The signature pattern: what started the work (an owner command or rule), what BARRY did (counted
 * from its records), and the verified result. Stages with nothing recorded say so.
 */
export function Flow({ command, commandBy, work, outcome, note }: { command: ReactNode; commandBy: ReactNode; work: FlowStage[]; outcome: FlowStage[]; note?: ReactNode }) {
  const stageList = (stages: FlowStage[]) => (
    <ul className="space-y-1.5">
      {stages.map((s) => (
        <li key={s.label} className="flex items-baseline justify-between gap-3 text-[13px]">
          <span className="text-o-muted">{s.label}</span>
          <span className={`font-semibold tabular-nums ${s.tone === "ok" ? "text-o-ok" : s.tone === "warn" ? "text-o-warn" : s.tone === "muted" ? "text-o-faint" : "text-o-ink"}`}>{s.value}</span>
        </li>
      ))}
    </ul>
  );
  const arrow = (
    <span aria-hidden className="flex items-center justify-center text-o-faint md:px-1">
      <Icon name="arrow" size={18} className="rotate-90 md:rotate-0" />
    </span>
  );
  return (
    <div className="grid grid-cols-1 items-stretch gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
      <div className="rounded-2xl bg-o-sunken/70 p-3.5 ring-1 ring-inset ring-o-line">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-o-muted">
          <Icon name="chat" size={13} /> {commandBy}
        </p>
        <p className="mt-1.5 text-[14px] font-medium leading-5 text-o-ink">{command}</p>
      </div>
      {arrow}
      <div className="rounded-2xl bg-o-accent/10 p-3.5 ring-1 ring-inset ring-o-accent/25">
        <p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-o-accent">
          <Orb size={16} alive={false} /> BARRY works
        </p>
        {stageList(work)}
      </div>
      {arrow}
      <div className="rounded-2xl bg-o-ok-bg/60 p-3.5 ring-1 ring-inset ring-o-ok-line">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-o-ok">
          <Icon name="check" size={13} /> Verified result
        </p>
        {stageList(outcome)}
      </div>
      {note && <p className="text-[12px] text-o-faint md:col-span-5">{note}</p>}
    </div>
  );
}

// ── Activity ─────────────────────────────────────────────────────────────────────────────────────

export function ActivityRow({ icon, tone, text, sub, when, onClick }: { icon: IconName; tone: Parameters<typeof IconTile>[0]["tone"]; text: ReactNode; sub?: ReactNode; when: ReactNode; onClick?: () => void }) {
  const inner = (
    <>
      <IconTile name={icon} tone={tone} size={30} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] text-o-ink">{text}</span>
        {sub && <span className="block truncate text-[12px] text-o-muted">{sub}</span>}
      </span>
      <span className="shrink-0 text-[11.5px] tabular-nums text-o-faint">{when}</span>
    </>
  );
  return onClick ? (
    <li>
      <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-1.5 py-2 text-left transition hover:bg-o-sunken">
        {inner}
      </button>
    </li>
  ) : (
    <li className="flex items-center gap-3 px-1.5 py-2">{inner}</li>
  );
}

/** Segmented filter (Inbox states, Money ranges). */
export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: { id: T; label: string; count?: number }[]; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} onClick={() => onChange(o.id)} className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition ${value === o.id ? "bg-o-primary text-o-on-primary" : "bg-o-sunken text-o-ink-2 ring-1 ring-inset ring-o-line hover:text-o-ink"}`}>
          {o.label}
          {o.count ? <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${value === o.id ? "bg-o-on-primary/15" : "bg-o-raised text-o-muted"}`}>{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** The page's hero line: eyebrow, a big human sentence, a supporting line. */
export function Hero({ eyebrow, title, lead, right }: { eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode; right?: ReactNode }) {
  return (
    <header className="o-rise flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="mt-2 text-[28px] font-semibold leading-[1.1] tracking-tight text-o-ink md:text-[40px]">{title}</h1>
        {lead && <p className="mt-2.5 text-[15px] leading-6 text-o-ink-2 md:text-base">{lead}</p>}
      </div>
      {right}
    </header>
  );
}

// ── Living interface ─────────────────────────────────────────────────────────────────────────────

/** A section label in the living interface ("BARRY IS WORKING · Live now"). */
export function StageTitle({ children, live, liveLabel, right }: { children: ReactNode; live?: LiveState; liveLabel?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] font-semibold uppercase tracking-[0.22em] text-o-ink-2">
        {live && <LiveDot state={live} />}
        {children}
        {liveLabel && <span className={`text-[11.5px] font-medium normal-case tracking-normal ${live === "live" || live === "working" ? "text-o-ok" : live === "attention" ? "text-o-warn" : "text-o-muted"}`}>{liveLabel}</span>}
      </h2>
      {right}
    </div>
  );
}

export type FlowBranch = { label: ReactNode; value: number | string; sub?: ReactNode; tone: "ok" | "accent" | "warn" | "muted"; live?: boolean };

const BRANCH_TONE = {
  ok: { stroke: "#3ddc97", text: "text-o-ok", ring: "ring-o-ok-line", bg: "bg-o-ok-bg/70", glow: "shadow-[0_0_28px_-8px_rgba(61,220,151,0.55)]" },
  accent: { stroke: "#7c9bff", text: "text-o-ink", ring: "ring-o-accent/35", bg: "bg-o-accent/10", glow: "shadow-[0_0_28px_-10px_rgba(91,140,255,0.6)]" },
  warn: { stroke: "#f6b54a", text: "text-o-warn", ring: "ring-o-warn-line", bg: "bg-o-warn-bg/70", glow: "" },
  muted: { stroke: "#3a4565", text: "text-o-muted", ring: "ring-o-line", bg: "bg-o-sunken/60", glow: "" },
} as const;

/**
 * THE LIVE OPERATION — input → BARRY activity → branches → outcomes. The source is the real cohort
 * (e.g. 3 unpaid payment links); each branch is a real count from the records (paid and verified,
 * followed up and waiting, queued, stopped). Paths stream only for branches that are still live.
 */
export function LiveFlow({ icon, title, sub, source, sourceLabel, branches, state, note }: { icon: IconName; title: ReactNode; sub?: ReactNode; source: number; sourceLabel: ReactNode; branches: FlowBranch[]; state?: ReactNode; note?: ReactNode }) {
  const id = useId().replace(/:/g, "");
  const n = Math.max(branches.length, 1);
  return (
    <div className="o-rise">
      <div className="flex items-start gap-3">
        <span className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-o-accent/15 text-o-accent ring-1 ring-inset ring-o-accent/40 shadow-[0_0_30px_-6px_rgba(91,140,255,0.7)]">
          <Icon name={icon} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-x-2 text-[16px] font-semibold tracking-tight text-o-ink">
            {title}
            {state}
          </h3>
          {sub && <p className="mt-0.5 text-[13px] text-o-muted">{sub}</p>}
        </div>
      </div>

      {/* Desktop / tablet: source → luminous paths → branches */}
      <div className="mt-4 hidden items-stretch sm:grid sm:grid-cols-[7.5rem_minmax(3rem,1fr)_minmax(0,15rem)]">
        <div className="flex flex-col justify-center">
          <p className="text-[44px] font-semibold leading-none tracking-tight tabular-nums text-o-ink">{source}</p>
          <p className="mt-1.5 text-[12.5px] leading-4 text-o-muted">{sourceLabel}</p>
        </div>
        <div className="relative">
        <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
          <defs>
            {branches.map((b, i) => (
              <linearGradient key={i} id={`${id}g${i}`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor="#5b8cff" stopOpacity="0.9" />
                <stop offset="0.55" stopColor="#9b7bff" stopOpacity="0.9" />
                <stop offset="1" stopColor={BRANCH_TONE[b.tone].stroke} stopOpacity={b.tone === "muted" ? 0.5 : 1} />
              </linearGradient>
            ))}
          </defs>
          {branches.map((b, i) => {
            const y = ((i + 0.5) / n) * 100;
            const d = `M0,50 C45,50 50,${y} 100,${y}`;
            const dim = b.tone === "muted" || b.value === 0;
            return (
              <g key={i} opacity={dim ? 0.35 : 1}>
                <path d={d} fill="none" stroke={`url(#${id}g${i})`} strokeWidth={7} strokeOpacity={0.12} vectorEffect="non-scaling-stroke" />
                <path d={d} fill="none" stroke={`url(#${id}g${i})`} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
                {b.live && !dim && <path d={d} fill="none" stroke="#e3ebff" strokeWidth={1.6} strokeLinecap="round" vectorEffect="non-scaling-stroke" className="o-flow-live" />}
              </g>
            );
          })}
        </svg>
        </div>
        <ul className="flex flex-col justify-between gap-2">
          {branches.map((b, i) => (
            <BranchNode key={i} b={b} />
          ))}
        </ul>
      </div>

      {/* Phones: the same flow, vertical */}
      <div className="mt-3 sm:hidden">
        <p className="flex items-baseline gap-2">
          <span className="text-[36px] font-semibold leading-none tracking-tight tabular-nums text-o-ink">{source}</span>
          <span className="text-[13px] text-o-muted">{sourceLabel}</span>
        </p>
        <ul className="relative mt-3 flex flex-col gap-2 pl-5">
          <span aria-hidden className="o-vline absolute bottom-3 left-[7px] top-0" />
          {branches.map((b, i) => (
            <li key={i} className="relative">
              <span aria-hidden className="absolute -left-[13px] top-1/2 h-px w-3" style={{ background: BRANCH_TONE[b.tone].stroke, opacity: b.tone === "muted" ? 0.4 : 0.9 }} />
              <BranchNode b={b} as="div" />
            </li>
          ))}
        </ul>
      </div>
      {note && <p className="mt-3 text-[12px] text-o-faint">{note}</p>}
    </div>
  );
}

function BranchNode({ b, as: As = "li" }: { b: FlowBranch; as?: "li" | "div" }) {
  const t = BRANCH_TONE[b.tone];
  return (
    <As className={`flex items-center gap-3 rounded-2xl px-3.5 py-2.5 ring-1 ring-inset ${t.ring} ${t.bg} ${b.value !== 0 ? t.glow : ""}`}>
      <span className={`text-[18px] font-semibold leading-none tabular-nums ${b.value === 0 ? "text-o-faint" : t.text}`}>{b.value}</span>
      <span className="min-w-0">
        <span className={`block text-[13px] leading-4 ${b.value === 0 ? "text-o-faint" : "text-o-ink-2"}`}>{b.label}</span>
        {b.sub && <span className={`mt-0.5 block text-[12.5px] font-semibold leading-4 ${t.text}`}>{b.sub}</span>}
      </span>
      {b.live && b.value !== 0 && <span className="ml-auto"><LiveDot state="working" /></span>}
    </As>
  );
}

/** A real-data trend line. Nothing to draw (all zero / under two points) → renders nothing, never a decorative squiggle. */
export function Sparkline({ values, tone = "ok", width = 96, height = 30, ariaLabel }: { values: number[]; tone?: "ok" | "accent" | "bad" | "violet"; width?: number; height?: number; ariaLabel: string }) {
  const id = useId().replace(/:/g, "");
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const max = Math.max(...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 3 - (v / max) * (height - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const color = { ok: "#3ddc97", accent: "#5b8cff", bad: "#ff7a7a", violet: "#9b7bff" }[tone];
  return (
    <svg role="img" aria-label={ariaLabel} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0 overflow-visible">
      <defs>
        <linearGradient id={`${id}a`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#${id}a)`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.4} fill={color} />
    </svg>
  );
}

/** One figure in a motion strip: icon disc, label, big value, real sparkline. No box — the strip draws the dividers. */
export function MotionStat({ icon, tone, label, value, sub, spark, onClick }: { icon: IconName; tone: "ok" | "accent" | "warn" | "bad" | "violet" | "neutral"; label: string; value: ReactNode; sub?: ReactNode; spark?: ReactNode; onClick?: () => void }) {
  const disc = { ok: "bg-o-ok/12 text-o-ok ring-o-ok/30 shadow-[0_0_24px_-6px_rgba(61,220,151,0.6)]", accent: "bg-o-accent/12 text-o-accent ring-o-accent/30 shadow-[0_0_24px_-6px_rgba(91,140,255,0.6)]", violet: "bg-o-violet/12 text-o-violet ring-o-violet/30 shadow-[0_0_24px_-6px_rgba(155,123,255,0.6)]", warn: "bg-o-warn/12 text-o-warn ring-o-warn/30", bad: "bg-o-bad/12 text-o-bad ring-o-bad/30 shadow-[0_0_24px_-8px_rgba(255,122,122,0.6)]", neutral: "bg-o-neutral-bg text-o-muted ring-o-line" }[tone];
  const inner = (
    <>
      <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ${disc}`}>
        <Icon name={icon} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-o-muted">{label}</span>
        <span className="mt-0.5 block truncate text-[24px] font-semibold leading-tight tracking-tight tabular-nums text-o-ink">{value}</span>
        {sub && <span className="block truncate text-[12px] text-o-faint">{sub}</span>}
      </span>
      {spark}
    </>
  );
  const cls = "flex w-full min-w-0 items-center gap-3 px-1 py-3 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${cls} rounded-2xl transition hover:bg-o-sunken/40`}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

/**
 * "Tell BARRY what to do…" — the primary input. The same command model serves the web today and the
 * Owner WhatsApp channel / voice later; the bar itself never executes anything — the caller interprets
 * the command against BARRY's real capabilities (see lib/owner/command).
 */
export function CommandBar({ value, onChange, onSubmit, busy, state = "idle", placeholder = "Tell BARRY what to do…", suggestions, onSuggestion, autoFocus }: { value: string; onChange: (v: string) => void; onSubmit: (v: string) => void; busy?: boolean; state?: PresenceState; placeholder?: string; suggestions?: { text: string; icon: IconName }[]; onSuggestion?: (text: string) => void; autoFocus?: boolean }) {
  return (
    <div>
      <form
        className="o-command flex items-center gap-2 p-1.5 pl-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value);
        }}
      >
        <BarryOrb size={40} state={busy ? "working" : state} />
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label="Tell BARRY what to do" maxLength={1000} autoFocus={autoFocus} className="min-w-0 flex-1 bg-transparent px-2 py-2.5 text-[16px] text-o-ink placeholder:text-o-muted focus:outline-none md:text-[17px]" />
        <button className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-o-accent text-white shadow-[0_0_24px_-4px_rgba(91,140,255,0.8)] transition hover:brightness-110 disabled:opacity-40 disabled:shadow-none" disabled={busy || !value.trim()} aria-label="Send to BARRY">
          {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="arrow" size={19} />}
        </button>
      </form>
      {suggestions && suggestions.length > 0 && (
        <div className="-mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1">
          {suggestions.map((s) => (
            <button key={s.text} type="button" disabled={busy} onClick={() => onSuggestion?.(s.text)} className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-2xl bg-o-surface/70 px-3.5 py-2 text-[13px] text-o-ink-2 ring-1 ring-inset ring-o-line transition hover:text-o-ink hover:ring-o-accent/40 disabled:opacity-50">
              <Icon name={s.icon} size={15} className="text-o-accent" />
              {s.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
