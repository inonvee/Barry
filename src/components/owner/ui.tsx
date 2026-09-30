"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/** Owner-workspace visual language: calm neutrals, one dark accent, status always with a label. */

export const card = "rounded-xl border border-[#e4e7ec] bg-white p-4 md:p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]";
export const btn = "rounded-lg border border-[#d0d5dd] bg-white px-3 py-1.5 text-sm font-medium text-[#344054] hover:bg-[#f9fafb] disabled:opacity-50";
export const primary = "rounded-lg bg-[#1d2939] px-3.5 py-1.5 text-sm font-medium text-white hover:bg-[#101828] disabled:opacity-50";
export const danger = "rounded-lg border border-[#fda29b] bg-white px-3 py-1.5 text-sm font-medium text-[#b42318] hover:bg-[#fef3f2] disabled:opacity-50";

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
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      {icon && <span aria-hidden className="text-[10px] font-bold">{ICON[tone]}</span>}
      {children}
    </span>
  );
}

export function Stat({ label, value, hint, emphasis }: { label: string; value: ReactNode; hint?: ReactNode; emphasis?: boolean }) {
  return (
    <div className={`${card} ${emphasis ? "border-[#1d2939]" : ""}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-[#667085]">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-[#101828] md:text-3xl">{value}</p>
      {hint && <p className="mt-1 text-xs text-[#667085]">{hint}</p>}
    </div>
  );
}

export function Section({ title, subtitle, right, children }: { title: string; subtitle?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className={card}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-[#101828]">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-[#667085]">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-[#d0d5dd] px-4 py-6 text-center text-sm text-[#667085]">{children}</p>;
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
  return new Date(iso).toLocaleDateString();
}

export function OwnerNav({ active }: { active: "dashboard" | "train" | "learn" | "connections" }) {
  const items = [
    { id: "dashboard", href: "/owner", label: "Dashboard" },
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
