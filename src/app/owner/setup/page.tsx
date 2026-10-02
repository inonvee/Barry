"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { OsPage } from "@/components/owner/OsPage";
import { AREA_ORDER, AreaCard } from "@/components/owner/AreaCard";
import { SetupPlan } from "@/components/owner/train-plan";
import { Pill, Section, Skeleton } from "@/components/owner/ui";
import { Icon, Panel, PanelHeader } from "@/components/owner/kit";
import type { useOwnerApi } from "@/components/owner/useOwnerApi";
import type { getTrainingProfile } from "@/lib/owner/training";
import type { OwnerOs } from "@/lib/owner/os-service";

/**
 * BARRY SETUP — the owner's onboarding and readiness in one place: Meet BARRY → Connect your business →
 * Teach BARRY → Decide what BARRY can do → Supervised start → Earn more autonomy (never automatic). The
 * level is the server's readiness assessment, never computed in the browser; every blocker says who acts
 * and links to where it's resolved. Release requirements for real customer traffic are the BARRY team's
 * and are shown apart, so they never read as the owner's to-do.
 */
type Profile = Awaited<ReturnType<typeof getTrainingProfile>>;
const STEP_TONE = { done: "bg-o-ok text-white", now: "bg-o-accent text-white", later: "bg-o-sunken text-o-faint ring-1 ring-inset ring-o-line" } as const;
const MODE_WORDS: Record<OwnerOs["mode"], { title: string; text: string }> = {
  simulator: { title: "Practice", text: "BARRY works on its simulator — nothing real reaches customers, stock or money." },
  supervised: { title: "Supervised", text: "BARRY works with real customers while the BARRY team watches closely; anything above your limits comes to you first." },
  live: { title: "On its own, within your rules", text: "BARRY acts on its own inside your rules; anything above your limits still comes to you first." },
};

function Capabilities({ api }: { api: ReturnType<typeof useOwnerApi> }) {
  const { businessId, call } = api;
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => {
    let cancelled = false;
    call<Profile>(`/api/owner/readiness?businessId=${encodeURIComponent(businessId)}`).then((d) => !cancelled && setP(d)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [businessId, call]);
  if (!p) return <Panel className="p-5"><Skeleton lines={3} /></Panel>;
  const a = p.assessment;
  return (
    <>
      <Section title="What BARRY can do for you" subtitle="By area. “Simulator only” means it works end to end on BARRY's simulator — nothing real reaches customers, stock or money yet." plain>
        <div className="grid gap-3 md:grid-cols-2">
          {AREA_ORDER.filter((area) => a.needs.some((n) => n.area === area)).map((area) => (
            <AreaCard key={area} area={area} needs={a.needs.filter((n) => n.area === area)} steps={a.steps} />
          ))}
        </div>
      </Section>
      <Section title="What unlocks next" subtitle="In the order that unlocks the most — why each matters, who does it, and what BARRY can do after." plain>
        <SetupPlan steps={a.steps} />
      </Section>
    </>
  );
}

export default function SetupPage() {
  return (
    <OsPage section="setup" eyebrow="BARRY setup" title="Getting BARRY ready." lead="Where BARRY stands, what's left and who does it. BARRY is never called ready without the evidence.">
      {(os, api) => {
        const s = os.setup;
        const mode = MODE_WORDS[os.mode];
        return (
          <>
            <Panel className="p-4 md:p-5" glow={s.supervisedReady}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-o-muted">Where BARRY stands</p>
              <p className="mt-1 text-[22px] font-semibold tracking-tight text-o-ink" data-testid="setup-headline">{s.headline}</p>
              <ol className="mt-4 flex flex-col gap-3">
                {s.journey.map((j, i) => {
                  const body = (
                    <>
                      <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${STEP_TONE[j.state]}`}>{j.state === "done" ? <Icon name="check" size={13} /> : i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-[14.5px] font-medium ${j.state === "later" ? "text-o-muted" : "text-o-ink"}`}>{j.title}</span>
                        <span className="block text-[12.5px] leading-5 text-o-muted">{j.detail}</span>
                      </span>
                      {j.href && j.state !== "done" && <Icon name="chevron" size={14} className="mt-1 text-o-faint" />}
                    </>
                  );
                  return <li key={j.id}>{j.href && j.state !== "done" ? <Link href={j.href} className="flex min-h-11 gap-3 rounded-xl p-1 hover:bg-o-sunken/50">{body}</Link> : <div className="flex gap-3 p-1">{body}</div>}</li>;
                })}
              </ol>
            </Panel>

            {s.groups.map((g) => (
              <Panel key={g.id} className="p-4 md:p-5">
                <PanelHeader icon={g.id === "owner" ? "flag" : g.id === "connection" ? "plug" : g.id === "team" ? "users" : "spark"} tone={g.id === "owner" ? "warn" : undefined} title={`${g.title} · ${g.items.length}`} />
                <ul className="mt-2 divide-y divide-o-line" data-group={g.id}>
                  {g.items.map((it) => (
                    <li key={it.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                      <span className="min-w-0">
                        <span className="block text-[14px] font-medium text-o-ink">{it.label}</span>
                        <span className="block text-[13px] text-o-ink-2">{it.detail}</span>
                        {it.fix && <span className="block text-[12px] text-o-muted">{it.fix}</span>}
                      </span>
                      {it.href && <Link href={it.href} className="inline-flex min-h-10 shrink-0 items-center gap-1 text-[13px] font-medium text-o-accent hover:underline">{it.linkLabel} <Icon name="chevron" size={13} /></Link>}
                    </li>
                  ))}
                </ul>
              </Panel>
            ))}

            <Panel className="p-4 md:p-5">
              <PanelHeader icon="shield" title="How autonomous is BARRY?" />
              <p className="mt-2 flex flex-wrap items-center gap-2 text-[14px] text-o-ink"><Pill tone={os.mode === "simulator" ? "warn" : "info"} icon={false}>{mode.title}</Pill> {mode.text}</p>
              <ul className="mt-3 flex flex-col gap-1.5 text-[13.5px] text-o-ink-2">
                <li>· <Link href="/owner/rules" className="font-medium text-o-accent hover:underline">Your limits</Link> decide what BARRY does on its own and what it asks you first.</li>
                <li>· You approve or decline each request in <Link href="/owner?tab=work" className="font-medium text-o-accent hover:underline">Work</Link> — or by replying to BARRY on WhatsApp.</li>
                <li>· Say “Stop all follow-ups” here or on WhatsApp and BARRY stops reaching out at once.</li>
              </ul>
              <p className="mt-3 text-[12.5px] text-o-muted">More autonomy is never automatic: after a supervised period, you and the BARRY team decide together what BARRY may do on its own.</p>
            </Panel>

            {s.later.length > 0 && (
              <details className="group rounded-2xl bg-o-sunken/40 p-4 ring-1 ring-inset ring-o-line">
                <summary className="cursor-pointer list-none text-[13.5px] font-medium text-o-ink-2">Before real customer traffic — the BARRY team&apos;s checklist ({s.later.length}) ›</summary>
                <ul className="mt-2 flex flex-col gap-2 text-[13px]">
                  {s.later.map((l) => (
                    <li key={l.id}><span className="font-medium text-o-ink">{l.label}</span> <span className="text-o-muted">— {l.detail}</span></li>
                  ))}
                </ul>
              </details>
            )}

            <Capabilities api={api} />
          </>
        );
      }}
    </OsPage>
  );
}
