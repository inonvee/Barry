"use client";

import Link from "next/link";
import { OsPage } from "@/components/owner/OsPage";
import { Pill, timeAgo, type Tone } from "@/components/owner/ui";
import { Panel } from "@/components/owner/kit";
import type { OwnerSystem, SystemLabel } from "@/lib/owner/os";

/**
 * CONNECTED SYSTEMS — what BARRY works through, labelled honestly: REAL, SIMULATED (BARRY's simulator —
 * nothing real happens), READ-ONLY, SUPERVISED, TEST MODE, UNAVAILABLE, NOT CONNECTED. What BARRY can read
 * and do through each comes from the capabilities the connected system really provides. Credentials are
 * never shown; the BARRY team connects systems.
 */
const LABEL_TONE: Record<SystemLabel, Tone> = { REAL: "good", SUPERVISED: "info", "READ-ONLY": "info", SIMULATED: "warn", "TEST MODE": "warn", UNAVAILABLE: "bad", "NOT CONNECTED": "neutral" };
const HEALTH: Record<OwnerSystem["health"], string> = { healthy: "Working", degraded: "Setup incomplete", down: "Not working", not_set_up: "Not set up" };

function SystemCard({ s }: { s: OwnerSystem }) {
  return (
    <Panel className="scroll-mt-24 p-4 md:p-5" id={s.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[15.5px] font-semibold text-o-ink">{s.name}</h3>
          <p className="text-[12.5px] text-o-muted">{s.provider ?? "No provider"} · {HEALTH[s.health]}{s.lastCheck ? ` · checked ${timeAgo(s.lastCheck)}` : ""}</p>
        </div>
        <span data-label={s.label}><Pill tone={LABEL_TONE[s.label]} icon={false}>{s.label}</Pill></span>
      </div>
      <p className="mt-2 text-[13.5px] leading-6 text-o-ink-2">{s.meaning}</p>
      {(s.reads.length > 0 || s.does.length > 0) && (
        <dl className="mt-3 grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-2">
          {s.reads.length > 0 && (
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-o-faint">BARRY can read</dt>
              <dd className="mt-1 flex flex-col gap-0.5 text-o-ink-2">{s.reads.map((r) => <span key={r}>{r}</span>)}</dd>
            </div>
          )}
          {s.does.length > 0 && (
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-o-faint">{s.label === "SIMULATED" ? "BARRY can do (on the simulator only)" : "BARRY can do (within your rules)"}</dt>
              <dd className="mt-1 flex flex-col gap-0.5 text-o-ink-2">{s.does.map((r) => <span key={r}>{r}</span>)}</dd>
            </div>
          )}
        </dl>
      )}
      {s.missingForLaunch.length > 0 && (
        <div className="mt-3 rounded-xl bg-o-warn-bg/50 px-3 py-2.5 text-[13px] ring-1 ring-inset ring-o-warn-line">
          <p className="font-medium text-o-ink">Missing before a supervised start</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-o-ink-2">{s.missingForLaunch.map((m) => <li key={m}>· {m}</li>)}</ul>
        </div>
      )}
      {s.id === "whatsapp_owner" && s.label === "NOT CONNECTED" && s.meaning.includes("Settings") && <Link href="/owner/settings#whatsapp" className="mt-2 inline-block text-[13px] font-medium text-o-accent hover:underline">Link your WhatsApp ›</Link>}
    </Panel>
  );
}

export default function SystemsPage() {
  return (
    <OsPage section="systems" eyebrow="Connected systems" title="What BARRY works through." lead="Each system, with what BARRY can read and do through it. SIMULATED means BARRY's simulator: nothing real reaches customers, stock or money.">
      {(os) => {
        const used = os.systems.filter((s) => s.used);
        const unused = os.systems.filter((s) => !s.used);
        return (
          <>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{used.map((s) => <SystemCard key={s.id} s={s} />)}</div>
            {unused.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer list-none text-[13px] font-medium text-o-muted hover:text-o-ink">Not used by your business ({unused.length}) ›</summary>
                <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">{unused.map((s) => <SystemCard key={s.id} s={s} />)}</div>
              </details>
            )}
            <p className="text-[12px] text-o-faint">The BARRY team connects systems with you — credentials are never shown here.</p>
          </>
        );
      }}
    </OsPage>
  );
}
