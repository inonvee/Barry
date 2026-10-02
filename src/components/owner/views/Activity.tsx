"use client";

import Link from "next/link";
import type { OwnerWorkspace } from "@/lib/owner/service";
import { activityTimeline } from "@/lib/owner/os";
import { formatLocal } from "@/lib/format/time";
import { Empty } from "../ui";
import { Hero, Icon } from "../kit";

/**
 * ACTIVITY — what happened, in human words, newest first: payments the provider verified, bookings,
 * follow-ups, requests BARRY brought to you and what you decided, what you asked BARRY (here or on
 * WhatsApp), what BARRY noticed. Every row opens its record (the conversation, the operation, the item).
 */
export function ActivityView({ ws, onOpen }: { ws: OwnerWorkspace; onOpen: (conversationId: string) => void }) {
  const items = activityTimeline(ws);
  const dot = { ok: "bg-o-ok", accent: "bg-o-accent", violet: "bg-o-violet", warn: "bg-o-warn", bad: "bg-o-bad", neutral: "bg-o-faint" } as const;
  return (
    <div className="flex flex-col gap-6">
      <Hero eyebrow={`Activity · ${ws.business.name}`} title="Everything that happened." lead="From BARRY's records only — payments count only once your provider verifies them, and test activity is marked." />
      {items.length === 0 ? (
        <Empty>Nothing recorded yet. Payments, follow-ups, decisions and what you ask BARRY appear here as they happen.</Empty>
      ) : (
        <ol className="relative flex flex-col">
          <span aria-hidden className="o-vline absolute bottom-2 left-[5px] top-2" />
          {items.map((f) => {
            const inner = (
              <>
                <span aria-hidden className={`absolute left-0 top-[13px] h-[11px] w-[11px] rounded-full ring-[3px] ring-o-canvas ${dot[f.tone]}`} />
                <span className="block break-words text-[14px] leading-6 text-o-ink">{f.text}</span>
                <span className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-o-faint">
                  <span className="tabular-nums">{formatLocal(f.at, ws.business.timezone)}</span>
                  {f.sub && <span className="min-w-0 break-words">· {f.sub}</span>}
                </span>
              </>
            );
            const cls = "relative flex min-h-12 w-full flex-col justify-center rounded-xl py-2 pl-6 pr-8 text-left transition hover:bg-o-sunken/50";
            const chevron = <Icon name="chevron" size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-o-faint" />;
            return (
              <li key={f.id} className="relative">
                {f.conversationId ? (
                  <button type="button" onClick={() => onOpen(f.conversationId!)} className={cls}>{inner}{chevron}</button>
                ) : f.href ? (
                  <Link href={f.href} className={cls}>{inner}{chevron}</Link>
                ) : (
                  <div className="relative py-2 pl-6 pr-2">{inner}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
