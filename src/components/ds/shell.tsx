"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { CommandBar, useCommandBar, type CommandResult } from "./CommandBar";
import { StatusPill, type Status } from "./primitives";

/**
 * APP SHELL — one shell for both experiences. Header: brand · primary navigation (desktop) · BARRY's
 * presence · business switcher · command entry. Phones: a bottom bar with the four primary surfaces
 * and "More"; the command bar opens as a sheet. Never a sidebar of twenty links.
 */

export type NavItem = { id: string; href: string; label: string; short?: string; badge?: number };

/** BARRY's presence — what it is doing right now, in one word plus a sentence. */
export type Presence = { state: "working" | "waiting" | "needs_you" | "degraded" | "paused"; text: string; href?: string };

const PRESENCE: Record<Presence["state"], { status: Status; word: string }> = {
  working: { status: "ok", word: "Working" },
  waiting: { status: "neutral", word: "Waiting" },
  needs_you: { status: "attention", word: "Needs you" },
  degraded: { status: "degraded", word: "Degraded" },
  paused: { status: "blocked", word: "Paused" },
};

export function PresenceChip({ presence }: { presence: Presence }) {
  const p = PRESENCE[presence.state];
  const inner = (
    <span className="inline-flex max-w-[16rem] items-center gap-1.5 text-[12px] text-[#475467]">
      <StatusPill status={p.status}>BARRY · {p.word}</StatusPill>
      <span className="hidden truncate lg:inline">{presence.text}</span>
    </span>
  );
  return presence.href ? (
    <Link href={presence.href} title={presence.text}>
      {inner}
    </Link>
  ) : (
    <span title={presence.text}>{inner}</span>
  );
}

export function AppShell({
  brand,
  brandHref,
  nav,
  active,
  presence,
  switcher,
  commands,
  search,
  askHref,
  askLabel,
  right,
  footer,
  children,
  onNavigate,
}: {
  brand: ReactNode;
  brandHref: string;
  nav: NavItem[];
  active: string;
  presence?: Presence;
  switcher?: ReactNode;
  commands: CommandResult[];
  search?: (q: string) => Promise<CommandResult[]>;
  askHref?: (q: string) => string;
  askLabel?: string;
  right?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  onNavigate?: (id: string) => boolean | void;
}) {
  const bar = useCommandBar();
  const [more, setMore] = useState(false);
  const primary = nav.slice(0, 4);
  const rest = nav.slice(4);
  const click = (id: string) => (e: React.MouseEvent) => {
    setMore(false);
    if (onNavigate?.(id)) e.preventDefault();
  };
  return (
    <div className="min-h-screen bg-[#f4f5f7] text-[#101828]">
      <header className="sticky top-0 z-30 border-b border-[#e4e7ec]/80 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
          <Link href={brandHref} className="shrink-0 text-[15px] font-bold tracking-tight">
            {brand}
          </Link>
          <nav className="hidden min-w-0 flex-1 items-center gap-0.5 md:flex" aria-label="Primary">
            {nav.map((n) => (
              <Link key={n.id} href={n.href} onClick={click(n.id)} aria-current={active === n.id ? "page" : undefined} className={`relative whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium ${active === n.id ? "bg-[#1d2939] text-white" : "text-[#475467] hover:bg-[#f2f4f7]"}`}>
                {n.label}
                {n.badge ? <span className={`ml-1.5 rounded-full px-1.5 text-[11px] ${active === n.id ? "bg-white/20 text-white" : "bg-[#b42318] text-white"}`}>{n.badge}</span> : null}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {presence && <PresenceChip presence={presence} />}
            {switcher}
            <button onClick={() => bar.setOpen(true)} className="hidden items-center gap-2 rounded-lg border border-[#e4e7ec] px-2.5 py-1.5 text-[12px] text-[#667085] hover:bg-[#f9fafb] md:inline-flex" aria-label="Open command bar">
              <span aria-hidden>⌕</span> Search <kbd className="rounded border border-[#e4e7ec] px-1 font-mono text-[10px]">⌘K</kbd>
            </button>
            {right}
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl">{children}</div>
      {footer && <div className="mx-auto w-full max-w-6xl px-4 pb-24 md:pb-8">{footer}</div>}

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-[#e4e7ec] bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label="Primary">
        {primary.map((n) => (
          <Link key={n.id} href={n.href} onClick={click(n.id)} aria-current={active === n.id ? "page" : undefined} className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${active === n.id ? "text-[#101828]" : "text-[#667085]"}`}>
            <span className={`h-1 w-6 rounded-full ${active === n.id ? "bg-[#1d2939]" : "bg-transparent"}`} />
            {n.short ?? n.label}
            {n.badge ? <span className="absolute right-3 top-2 rounded-full bg-[#b42318] px-1.5 text-[10px] text-white">{n.badge}</span> : null}
          </Link>
        ))}
        <button onClick={() => (rest.length ? setMore(true) : bar.setOpen(true))} className={`flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${rest.some((n) => n.id === active) ? "text-[#101828]" : "text-[#667085]"}`} aria-label={rest.length ? "More" : "Search"}>
          <span className={`h-1 w-6 rounded-full ${rest.some((n) => n.id === active) ? "bg-[#1d2939]" : "bg-transparent"}`} />
          {rest.length ? "More" : "Search"}
        </button>
      </nav>

      {more && (
        <Sheet onClose={() => setMore(false)} title="More">
          <button onClick={() => { setMore(false); bar.setOpen(true); }} className="flex min-h-12 w-full items-center gap-2 rounded-xl bg-[#f4f5f7] px-4 text-left text-[15px] font-medium">
            <span aria-hidden>⌕</span> Search / switch business
          </button>
          <ul className="mt-2 divide-y divide-[#f2f4f7]">
            {rest.map((n) => (
              <li key={n.id}>
                <Link href={n.href} onClick={click(n.id)} className={`flex min-h-12 items-center justify-between px-1 text-[15px] ${active === n.id ? "font-semibold text-[#101828]" : "text-[#344054]"}`}>
                  {n.label}
                  {n.badge ? <span className="rounded-full bg-[#b42318] px-1.5 text-[11px] text-white">{n.badge}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </Sheet>
      )}

      <CommandBar open={bar.open} onClose={bar.close} items={commands} search={search} askHref={askHref} askLabel={askLabel} />
    </div>
  );
}

/** A bottom sheet on phones, a centered panel on desktop (context drawers, "more", confirmations). */
export function Sheet({ title, onClose, children }: { title?: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-[#101828]/40 md:items-center" onClick={onClose} role="presentation">
      <div role="dialog" aria-modal="true" className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl md:max-w-md md:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          {title && <p className="text-[15px] font-semibold">{title}</p>}
          <button onClick={onClose} className="rounded-md px-2 py-1 text-[12px] text-[#667085] hover:bg-[#f2f4f7]" aria-label="Close">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** The business switcher: a native select (keyboard + screen-reader friendly, one tap on phones). */
export function BusinessSwitcher({ value, options, onChange, label = "Current business" }: { value: string; options: { id: string; name: string }[]; onChange: (id: string) => void; label?: string }) {
  if (options.length <= 1) return <span className="truncate text-[13px] font-medium">{options[0]?.name ?? value}</span>;
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="max-w-[11rem] truncate rounded-lg border border-[#d0d5dd] bg-white px-2 py-1.5 text-[13px] font-medium text-[#101828]">
      {options.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  );
}
