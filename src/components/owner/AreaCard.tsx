"use client";

import { Pill, type Tone } from "./ui";
import type { BusinessNeed, NeedArea, SetupStep } from "@/lib/owner/capabilities";

/** What BARRY can do in one area of the business — for real, on a simulator only, or not yet — and what unlocks the rest. */
const AREA: Record<NeedArea, string> = { sell: "Selling", money: "Money", book: "Booking", support: "Support & your systems", knowledge: "Knowledge", channel: "Channels", platform: "Platform" };
export const AREA_ORDER: NeedArea[] = ["sell", "money", "book", "support", "knowledge", "channel", "platform"];

function authorityWords(n: BusinessNeed): string {
  if (n.authority === "never") return "Never";
  if (n.authority === "owner_approval") return "Only with your approval";
  if (n.authority === "within_limits") return n.authorityWords[0].toUpperCase() + n.authorityWords.slice(1);
  return `On its own${n.authority === "read" ? " (reads only)" : ""}`;
}

/** One area of the business: what BARRY can do there, for real or on a simulator, and what it can't yet. */
export function AreaCard({ area, needs, steps }: { area: NeedArea; needs: BusinessNeed[]; steps: SetupStep[] }) {
  const real = needs.filter((n) => n.status === "ready");
  const sim = needs.filter((n) => n.status === "ready_simulated");
  const missing = needs.filter((n) => n.status === "needs_setup");
  const tone: Tone = missing.length && !real.length && !sim.length ? "bad" : sim.length || missing.length ? "warn" : "good";
  const label = tone === "good" ? "Ready" : missing.length && !real.length && !sim.length ? "Not set up" : sim.length && !missing.length ? "Simulator only" : "Partly ready";
  const unlockSteps = [...new Set(needs.flatMap((n) => n.blockedBy))].map((id) => steps.find((s) => s.id === id)).filter((s): s is SetupStep => Boolean(s));
  return (
    <div className="o-panel rounded-2xl p-4 md:p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold">{AREA[area]}</h3>
        <Pill tone={tone}>{label}</Pill>
      </div>
      {real.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-o-muted">BARRY can</p>
          <ul className="mt-1 space-y-1.5">
            {real.map((n) => (
              <li key={n.id} className="text-[14px]">
                <span className="text-o-ink">{n.title}</span>
                <span className="block text-[12px] text-o-muted">{authorityWords(n)}{n.provider ? ` · via ${n.provider}` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {sim.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-o-warn">On a simulator only — nothing real happens yet</p>
          <ul className="mt-1 space-y-1.5">
            {sim.map((n) => (
              <li key={n.id} className="text-[14px]">
                <span className="text-o-ink">{n.title}</span>
                <span className="block text-[12px] text-o-muted">{authorityWords(n)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {missing.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-o-bad">Can&apos;t yet</p>
          <ul className="mt-1 space-y-1.5">
            {missing.map((n) => (
              <li key={n.id} className="text-[14px]">
                <span className="text-o-ink">{n.title}</span>
                <span className="block text-[12px] text-o-muted">{n.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {unlockSteps.length > 0 && (
        <div className="mt-3 rounded-xl bg-o-sunken/60 px-3 py-2.5 ring-1 ring-inset ring-o-line">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-o-muted">To unlock</p>
          <ul className="mt-1 space-y-1">
            {unlockSteps.map((s) => (
              <li key={s.id} className="text-[13px]">
                <a href={`#step-${s.id}`} className="font-medium text-o-ink underline-offset-2 hover:underline">
                  {s.title}
                </a>
                <span className="text-o-muted"> → then BARRY can {s.unlocks.slice(0, 3).map((u) => u.toLowerCase()).join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

