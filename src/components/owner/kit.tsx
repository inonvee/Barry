"use client";

import Link from "next/link";
import type { ReactNode } from "react";

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

/** BARRY's orb. `alive` only when BARRY is actually running (real state), never as decoration. */
export function Orb({ size = 36, alive = true }: { size?: number; alive?: boolean }) {
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center rounded-full ${alive ? "o-orb" : ""}`} style={{ width: size, height: size, background: "radial-gradient(circle at 35% 30%, #c9d6ff 0%, #6d8dff 32%, #3a2fb8 70%, #120d3d 100%)" }} aria-hidden>
      <span className="absolute rounded-full bg-[#0b1030]" style={{ width: size * 0.58, height: size * 0.42, top: size * 0.3 }} />
      <span className="absolute flex gap-[18%]" style={{ top: size * 0.42, width: size * 0.34 }}>
        <span className="rounded-full bg-[#c9d6ff]" style={{ width: size * 0.09, height: size * 0.09 }} />
        <span className="ml-auto rounded-full bg-[#c9d6ff]" style={{ width: size * 0.09, height: size * 0.09 }} />
      </span>
    </span>
  );
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
