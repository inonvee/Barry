"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { moneyParts } from "@/lib/format/money";

/**
 * THE OWNER PRODUCT'S PRIMITIVES — semantic `o-*` tokens only (see globals.css): light by default, the
 * dark control room inside `.barry-owner`. Status is always icon + word + color, never color alone;
 * tap targets ≥40px; depth comes from surfaces, not borders.
 */

export const card = "o-panel rounded-2xl p-4 md:p-5";
export const btn = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-o-sunken px-3.5 py-2 text-sm font-medium text-o-ink-2 ring-1 ring-inset ring-o-line transition hover:bg-o-raised hover:text-o-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-o-accent disabled:opacity-50";
export const primary = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-o-primary px-4 py-2 text-sm font-semibold text-o-on-primary shadow-o transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-o-accent focus-visible:ring-offset-2 focus-visible:ring-offset-o-canvas disabled:opacity-50";
export const accent = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-o-accent px-4 py-2 text-sm font-semibold text-white shadow-o-glow transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-o-violet disabled:opacity-50";
export const danger = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-o-bad-bg px-3.5 py-2 text-sm font-medium text-o-bad ring-1 ring-inset ring-o-bad-line transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-o-bad disabled:opacity-50";
export const quiet = "inline-flex min-h-9 items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium text-o-muted transition hover:bg-o-sunken hover:text-o-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-o-accent";
export const input = "min-h-11 w-full rounded-xl bg-o-sunken px-4 text-[15px] text-o-ink ring-1 ring-inset ring-o-line placeholder:text-o-faint transition focus:outline-none focus:ring-2 focus:ring-o-accent";

const TONES = {
  good: "bg-o-ok-bg text-o-ok ring-o-ok-line",
  warn: "bg-o-warn-bg text-o-warn ring-o-warn-line",
  bad: "bg-o-bad-bg text-o-bad ring-o-bad-line",
  info: "bg-o-info-bg text-o-info ring-o-info-line",
  neutral: "bg-o-neutral-bg text-o-neutral ring-o-neutral-line",
} as const;
export type Tone = keyof typeof TONES;

const ICON: Record<Tone, string> = { good: "✓", warn: "!", bad: "✕", info: "i", neutral: "•" };

/** Status pill: icon + label + color — never color alone. */
export function Pill({ tone = "neutral", children, icon = true }: { tone?: Tone; children: ReactNode; icon?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${TONES[tone]}`}>
      {icon && <span aria-hidden className="text-[10px] font-bold">{ICON[tone]}</span>}
      {children}
    </span>
  );
}

export function Stat({ label, value, hint, emphasis, tone }: { label: string; value: ReactNode; hint?: ReactNode; emphasis?: boolean; tone?: Tone }) {
  return (
    <div className={`${card} ${emphasis ? "shadow-o-glow" : ""}`}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-o-muted">{label}</p>
      <p className={`mt-1.5 text-3xl font-semibold tracking-tight tabular-nums ${tone === "good" ? "text-o-ok" : tone === "bad" ? "text-o-bad" : "text-o-ink"}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-o-muted">{hint}</p>}
    </div>
  );
}

export function Section({ title, subtitle, right, children, plain, id }: { title: string; subtitle?: string; right?: ReactNode; children: ReactNode; plain?: boolean; id?: string }) {
  return (
    <section id={id} className={plain ? "" : card}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-o-ink md:text-base">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] leading-5 text-o-muted">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/** An intentional empty state: what this space shows once something happens. */
export function Empty({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <div className="rounded-2xl bg-o-sunken/60 px-4 py-7 text-center ring-1 ring-inset ring-o-line">
      {title && <p className="text-sm font-semibold text-o-ink">{title}</p>}
      <p className={`mx-auto max-w-md text-sm leading-6 text-o-muted ${title ? "mt-1" : ""}`}>{children}</p>
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2.5" aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="o-shimmer h-3.5 rounded-full" style={{ width: `${88 - i * 14}%` }} />
      ))}
    </div>
  );
}

/** A page-level state the owner must understand (not signed in, wrong business, error, degraded). */
export function StateNotice({ tone, title, children, action }: { tone: Tone; title: string; children?: ReactNode; action?: ReactNode }) {
  const bg = tone === "bad" ? "bg-o-bad-bg ring-o-bad-line" : tone === "warn" ? "bg-o-warn-bg ring-o-warn-line" : tone === "good" ? "bg-o-ok-bg ring-o-ok-line" : "bg-o-surface ring-o-line";
  const dot = tone === "bad" ? "bg-o-bad" : tone === "warn" ? "bg-o-warn" : tone === "good" ? "bg-o-ok" : "bg-o-accent";
  return (
    <div className={`rounded-2xl px-4 py-3.5 ring-1 ring-inset ${bg}`} role="status">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 gap-2.5">
          <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-o-ink">{title}</p>
            {children && <div className="mt-1 text-sm leading-6 text-o-ink-2">{children}</div>}
          </div>
        </div>
        {action}
      </div>
    </div>
  );
}

/**
 * Money in words: one figure per currency. Two currencies are two figures separated by " · " —
 * never "+" and never a combined number (BARRY does not add across currencies).
 */
export function formatMoney(m: Record<string, number> | undefined): string {
  const parts = moneyParts(m);
  if (parts.length === 0) return "—";
  return parts.map((p) => p.text).join(" · ");
}

/** Per-currency figures as separate chips (the visual form of `formatMoney`). */
export function MoneyFigures({ money, tone, empty = "—" }: { money: Record<string, number> | undefined; tone?: Tone; empty?: string }) {
  const parts = moneyParts(money);
  if (parts.length === 0) return <span className="text-o-faint">{empty}</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      {parts.map((p) => (
        <span key={p.currency} className={`font-semibold tabular-nums tracking-tight ${tone === "good" ? "text-o-ok" : tone === "bad" ? "text-o-bad" : "text-o-ink"}`}>{p.text}</span>
      ))}
      {parts.length > 1 && <span className="text-[11px] font-normal text-o-faint">separate currencies</span>}
    </span>
  );
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

/** Legacy nav kept for the pages that still use it (Learn business / Connections). */
export function OwnerNav({ active }: { active: "dashboard" | "train" | "learn" | "connections" }) {
  const items = [
    { id: "dashboard", href: "/owner", label: "Today" },
    { id: "train", href: "/owner/train", label: "Train BARRY" },
    { id: "learn", href: "/learnbusiness", label: "Learn business" },
    { id: "connections", href: "/connections", label: "Connections" },
  ] as const;
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1">
      {items.map((i) => (
        <Link key={i.id} href={i.href} className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${active === i.id ? "bg-o-primary text-o-on-primary" : "text-o-ink-2 hover:bg-o-sunken"}`}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
