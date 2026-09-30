"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The owner product's visual language: quiet neutrals, one dark accent, status always as icon + word,
 * generous tap targets, and very few borders. Every surface in /owner builds from these.
 */

export const card = "rounded-2xl bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_0_0_1px_rgba(16,24,40,0.04)] md:p-5";
export const btn = "inline-flex min-h-10 items-center justify-center rounded-lg border border-[#d0d5dd] bg-white px-3.5 py-2 text-sm font-medium text-[#344054] hover:bg-[#f9fafb] disabled:opacity-50";
export const primary = "inline-flex min-h-10 items-center justify-center rounded-lg bg-[#1d2939] px-4 py-2 text-sm font-semibold text-white hover:bg-[#101828] disabled:opacity-50";
export const danger = "inline-flex min-h-10 items-center justify-center rounded-lg border border-[#fda29b] bg-white px-3.5 py-2 text-sm font-medium text-[#b42318] hover:bg-[#fef3f2] disabled:opacity-50";
export const quiet = "inline-flex min-h-9 items-center rounded-lg px-2.5 py-1.5 text-sm font-medium text-[#475467] hover:bg-[#f2f4f7]";

const TONES = {
  good: "bg-[#ecfdf3] text-[#067647] ring-[#abefc6]",
  warn: "bg-[#fffaeb] text-[#b54708] ring-[#fedf89]",
  bad: "bg-[#fef3f2] text-[#b42318] ring-[#fecdca]",
  info: "bg-[#eff8ff] text-[#175cd3] ring-[#b2ddff]",
  neutral: "bg-[#f2f4f7] text-[#344054] ring-[#e4e7ec]",
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
    <div className={`${card} ${emphasis ? "ring-1 ring-[#1d2939]" : ""}`}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#667085]">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tabular-nums md:text-3xl ${tone === "good" ? "text-[#067647]" : tone === "bad" ? "text-[#b42318]" : "text-[#101828]"}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-[#667085]">{hint}</p>}
    </div>
  );
}

export function Section({ title, subtitle, right, children, plain, id }: { title: string; subtitle?: string; right?: ReactNode; children: ReactNode; plain?: boolean; id?: string }) {
  return (
    <section id={id} className={plain ? "" : card}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-[#101828] md:text-base">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] text-[#667085]">{subtitle}</p>}
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
    <div className="rounded-xl bg-[#f9fafb] px-4 py-6 text-center">
      {title && <p className="text-sm font-semibold text-[#101828]">{title}</p>}
      <p className={`text-sm text-[#667085] ${title ? "mt-1" : ""}`}>{children}</p>
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="animate-pulse space-y-2" aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-3.5 rounded bg-[#eaecf0]" style={{ width: `${88 - i * 14}%` }} />
      ))}
    </div>
  );
}

/** A page-level state the owner must understand (not signed in, wrong business, error, degraded). */
export function StateNotice({ tone, title, children, action }: { tone: Tone; title: string; children?: ReactNode; action?: ReactNode }) {
  const bg = tone === "bad" ? "border-[#fecdca] bg-[#fef3f2]" : tone === "warn" ? "border-[#fedf89] bg-[#fffaeb]" : tone === "good" ? "border-[#abefc6] bg-[#f6fef9]" : "border-[#e4e7ec] bg-white";
  return (
    <div className={`rounded-2xl border px-4 py-4 ${bg}`} role="status">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#101828]">{title}</p>
          {children && <div className="mt-1 text-sm text-[#475467]">{children}</div>}
        </div>
        {action}
      </div>
    </div>
  );
}

export function formatMoney(m: Record<string, number> | undefined): string {
  const entries = Object.entries(m ?? {});
  if (entries.length === 0) return "—";
  return entries
    .map(([currency, amount]) => {
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
      } catch {
        return `${amount} ${currency}`;
      }
    })
    .join(" + ");
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
        <Link key={i.id} href={i.href} className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${active === i.id ? "bg-[#1d2939] text-white" : "text-[#475467] hover:bg-[#f2f4f7]"}`}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
