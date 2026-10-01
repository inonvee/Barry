"use client";

import Link from "next/link";
import { useCallback, type ReactNode } from "react";
import { AppShell, type NavItem, type Presence } from "@/components/ds/shell";
import type { CommandResult } from "@/components/ds/CommandBar";

/**
 * HQ SHELL — the founder's experience: FOCUS · FLEET · INCIDENTS · ACTIVITY · MONEY · RELEASES · BARRY ·
 * SETTINGS. Focused and fleet-wide; not the owner shell with more permissions. The command bar searches
 * the fleet through a founder-only API (real records only).
 */

export type HqSurface = "focus" | "fleet" | "incidents" | "activity" | "money" | "releases" | "barry" | "settings" | "ask" | "business";

export const HQ_NAV: NavItem[] = [
  { id: "focus", href: "/hq", label: "Focus", short: "Focus" },
  { id: "fleet", href: "/hq/fleet", label: "Fleet" },
  { id: "incidents", href: "/hq/incidents", label: "Incidents" },
  { id: "activity", href: "/hq/activity", label: "Activity" },
  { id: "money", href: "/hq/money", label: "Money" },
  { id: "releases", href: "/hq/releases", label: "Releases" },
  { id: "barry", href: "/hq/barry", label: "BARRY" },
  { id: "settings", href: "/hq/settings", label: "Settings" },
];

export type HqShellData = { presence: Presence; businesses: { id: string; name: string; status: "ok" | "attention" | "blocked" }[]; badges?: Partial<Record<string, number>>; build: string };

export function HqShell({ active, data, children }: { active: HqSurface; data: HqShellData; children: ReactNode }) {
  const search = useCallback(async (q: string): Promise<CommandResult[]> => {
    const r = await fetch(`/api/hq/search?q=${encodeURIComponent(q)}`, { credentials: "same-origin" });
    if (!r.ok) return [];
    const d = (await r.json()) as { results: CommandResult[] };
    return d.results;
  }, []);
  const commands: CommandResult[] = [
    ...data.businesses.map((b) => ({ id: `business:${b.id}`, kind: "business" as const, title: b.name, subtitle: "Business focus", href: `/hq/${encodeURIComponent(b.id)}`, status: b.status, keywords: [b.id] })),
    ...HQ_NAV.map((n) => ({ id: `surface:${n.id}`, kind: "surface" as const, title: n.label, href: n.href })),
    { id: "surface:ask", kind: "surface", title: "Ask HQ BARRY", href: "/hq/ask" },
    { id: "surface:qa", kind: "surface", title: "QA tools", subtitle: "Scenario factory, test owner, reset", href: "/qa" },
  ];
  return (
    <AppShell
      brand="BARRY HQ"
      brandHref="/hq"
      nav={HQ_NAV.map((n) => ({ ...n, badge: data.badges?.[n.id] }))}
      active={active}
      presence={data.presence}
      commands={commands}
      search={search}
      askHref={(q) => `/hq/ask?q=${encodeURIComponent(q)}`}
      askLabel="Ask HQ"
      right={
        <form action="/api/hq/logout" method="post" className="hidden md:block">
          <button className="rounded-lg px-2 py-1.5 text-[12px] text-[#667085] hover:bg-[#f2f4f7]">Sign out</button>
        </form>
      }
      footer={
        <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#98a2b3]">
          <span>{data.build}</span>
          <span className="flex gap-3">
            <Link href="/hq/ask" className="hover:text-[#475467]">Ask HQ</Link>
            <Link href="/qa" className="hover:text-[#475467]">QA tools</Link>
            <Link href="/simulator" className="hover:text-[#475467]">Simulator</Link>
            <form action="/api/hq/logout" method="post" className="md:hidden">
              <button className="hover:text-[#475467]">Sign out</button>
            </form>
          </span>
        </footer>
      }
    >
      {children}
    </AppShell>
  );
}
