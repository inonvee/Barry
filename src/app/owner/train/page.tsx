"use client";

import { useEffect, useState } from "react";
import { useOwnerApi } from "@/components/owner/useOwnerApi";
import { OwnerShell } from "@/components/owner/OwnerShell";
import { Empty, Pill, Section, Skeleton, StateNotice, quiet, type Tone } from "@/components/owner/ui";
import type { getTrainingProfile } from "@/lib/owner/training";
import type { PilotLevel, ReadinessCheck } from "@/lib/owner/readiness";
import type { BusinessNeed, NeedArea, SetupStep } from "@/lib/owner/capabilities";

/**
 * TRAIN BARRY — like training an employee, not filling in a configuration checklist. What BARRY knows,
 * what it can do (for real, or on a simulator only), what it can't do yet, what it needs from you, and
 * what each step unlocks. All of it comes from the one capability-readiness model and the Genome.
 */

type Profile = Awaited<ReturnType<typeof getTrainingProfile>>;

const LEVELS: PilotLevel[] = ["NOT_READY", "READY_FOR_TESTING", "READY_FOR_SUPERVISED_PILOT", "READY_FOR_CUSTOMER_TRAFFIC"];
const LEVEL_SHORT: Record<PilotLevel, string> = { NOT_READY: "Not ready", READY_FOR_TESTING: "Testing", READY_FOR_SUPERVISED_PILOT: "Supervised pilot", READY_FOR_CUSTOMER_TRAFFIC: "Customer traffic" };
const CHECK_TONE: Record<ReadinessCheck["status"], { tone: Tone; label: string }> = { pass: { tone: "good", label: "Done" }, warn: { tone: "warn", label: "Recommended" }, fail: { tone: "bad", label: "Missing" } };
const AREA: Record<NeedArea, string> = { sell: "Selling", money: "Money", book: "Booking", support: "Support & your systems", knowledge: "Knowledge", channel: "Channels", platform: "Platform" };
const AREA_ORDER: NeedArea[] = ["sell", "money", "book", "support", "knowledge", "channel", "platform"];
const GATE_WORDS: Record<SetupStep["gate"], string> = { testing: "to test BARRY", supervised_pilot: "for the supervised pilot", customer_traffic: "for customer traffic" };

function authorityWords(n: BusinessNeed): string {
  if (n.authority === "never") return "Never";
  if (n.authority === "owner_approval") return "Only with your approval";
  if (n.authority === "within_limits") return n.authorityWords[0].toUpperCase() + n.authorityWords.slice(1);
  return `On its own${n.authority === "read" ? " (reads only)" : ""}`;
}

/** One area of the business: what BARRY can do there, for real or on a simulator, and what it can't yet. */
function AreaCard({ area, needs, steps }: { area: NeedArea; needs: BusinessNeed[]; steps: SetupStep[] }) {
  const real = needs.filter((n) => n.status === "ready");
  const sim = needs.filter((n) => n.status === "ready_simulated");
  const missing = needs.filter((n) => n.status === "needs_setup");
  const tone: Tone = missing.length && !real.length && !sim.length ? "bad" : sim.length || missing.length ? "warn" : "good";
  const label = tone === "good" ? "Ready" : missing.length && !real.length && !sim.length ? "Not set up" : sim.length && !missing.length ? "Simulator only" : "Partly ready";
  const unlockSteps = [...new Set(needs.flatMap((n) => n.blockedBy))].map((id) => steps.find((s) => s.id === id)).filter((s): s is SetupStep => Boolean(s));
  return (
    <div className="rounded-2xl bg-white p-4 md:p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold">{AREA[area]}</h3>
        <Pill tone={tone}>{label}</Pill>
      </div>
      {real.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#667085]">BARRY can</p>
          <ul className="mt-1 space-y-1.5">
            {real.map((n) => (
              <li key={n.id} className="text-[14px]">
                <span className="text-[#101828]">{n.title}</span>
                <span className="block text-[12px] text-[#667085]">{authorityWords(n)}{n.provider ? ` · via ${n.provider}` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {sim.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#b54708]">On a simulator only — nothing real happens yet</p>
          <ul className="mt-1 space-y-1.5">
            {sim.map((n) => (
              <li key={n.id} className="text-[14px]">
                <span className="text-[#101828]">{n.title}</span>
                <span className="block text-[12px] text-[#667085]">{authorityWords(n)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {missing.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#b42318]">Can&apos;t yet</p>
          <ul className="mt-1 space-y-1.5">
            {missing.map((n) => (
              <li key={n.id} className="text-[14px]">
                <span className="text-[#101828]">{n.title}</span>
                <span className="block text-[12px] text-[#667085]">{n.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {unlockSteps.length > 0 && (
        <div className="mt-3 rounded-xl bg-[#f9fafb] px-3 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#667085]">To unlock</p>
          <ul className="mt-1 space-y-1">
            {unlockSteps.map((s) => (
              <li key={s.id} className="text-[13px]">
                <a href={`#step-${s.id}`} className="font-medium text-[#101828] underline-offset-2 hover:underline">
                  {s.title}
                </a>
                <span className="text-[#667085]"> → then BARRY can {s.unlocks.slice(0, 3).map((u) => u.toLowerCase()).join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SetupPlan({ steps }: { steps: SetupStep[] }) {
  if (steps.length === 0) return <Empty title="Nothing left to set up">BARRY can do everything your business asks of it, for real.</Empty>;
  const yours = steps.filter((s) => s.who === "you");
  const team = steps.filter((s) => s.who !== "you");
  const Step = ({ s, i }: { s: SetupStep; i: number }) => (
    <li id={`step-${s.id}`} className="rounded-2xl bg-white p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#1d2939] text-[12px] font-semibold text-white">{i + 1}</span>
        <p className="text-[15px] font-semibold text-[#101828]">{s.title}</p>
        <span className="text-[12px] text-[#98a2b3]">{GATE_WORDS[s.gate]}</span>
      </div>
      <dl className="mt-3 space-y-2">
        <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#98a2b3] sm:pt-0.5">Why it matters</dt>
          <dd className="text-[14px] text-[#344054]">{s.why}</dd>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#98a2b3] sm:pt-0.5">How</dt>
          <dd className="text-[14px] text-[#344054]">{s.how}</dd>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#98a2b3] sm:pt-0.5">Then BARRY can</dt>
          <dd className="text-[14px] font-medium text-[#067647]">{s.unlocks.join(" · ")}</dd>
        </div>
      </dl>
    </li>
  );
  return (
    <div className="flex flex-col gap-5">
      {yours.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#667085]">What BARRY needs from you</p>
          <ol className="flex flex-col gap-3">
            {yours.map((s, i) => (
              <Step key={s.id} s={s} i={i} />
            ))}
          </ol>
        </div>
      )}
      {team.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#667085]">With the BARRY team</p>
          <ol className="flex flex-col gap-3">
            {team.map((s, i) => (
              <Step key={s.id} s={s} i={yours.length + i} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[#667085]">{k}</dt>
          <dd className="break-words text-[#101828]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function TrainBarryPage() {
  const api = useOwnerApi();
  const { businessId, call, authorized } = api;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    if (!businessId || !authorized) return;
    let cancelled = false;
    call<Profile>(`/api/owner/readiness?businessId=${encodeURIComponent(businessId)}`)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setError("");
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setProfile(null);
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, call, authorized]);

  const p = authorized && profile?.business.id === businessId ? profile : null;
  const r = p?.readiness;
  const s = p?.sections;
  const a = p?.assessment;
  return (
    <OwnerShell api={api} active="train">
      <div className="flex flex-col gap-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#667085]">Train BARRY · {api.business?.name ?? "—"}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">{a ? (a.afterSetup.length === 0 ? "BARRY is fully trained for your business" : `${a.now.length} thing${a.now.length === 1 ? "" : "s"} BARRY does for real · ${a.afterSetup.length} to unlock`) : "What BARRY knows and can do"}</h1>
          <p className="mt-1 text-sm text-[#667085]">Everything here comes from what BARRY actually runs on — your goals, your connected systems and your rules — never a separate form.</p>
        </div>
        {error && <StateNotice tone="bad" title="Couldn't load BARRY's training profile">{error}</StateNotice>}
        {authorized && !p && !error && (
          <div className="rounded-2xl bg-white p-5">
            <Skeleton lines={4} />
          </div>
        )}

        {r && (
          <section className="rounded-2xl bg-[#1d2939] p-4 text-white md:p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/60">Where BARRY stands</p>
            <p className="mt-1 text-xl font-semibold">{r.label}</p>
            <ol className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4" aria-label="Readiness levels">
              {LEVELS.map((l) => {
                const reached = LEVELS.indexOf(l) <= LEVELS.indexOf(r.level);
                return (
                  <li key={l} className={`rounded-lg px-2.5 py-1.5 text-[13px] ${reached ? "bg-white text-[#101828]" : "bg-white/10 text-white/70"}`}>
                    {reached ? "✓ " : ""}
                    {LEVEL_SHORT[l]}
                  </li>
                );
              })}
            </ol>
            {r.next && <p className="mt-3 text-[13px] text-white/80">Next: {r.next.label} — {r.next.blockers.length} thing{r.next.blockers.length === 1 ? "" : "s"} left, all in the plan below.</p>}
          </section>
        )}

        {a && (
          <>
            <Section title="What BARRY can do for you" subtitle="By area. “Simulator only” means it works end to end on BARRY's simulator — nothing real reaches customers, stock or money yet." plain>
              <div className="grid gap-3 md:grid-cols-2">
                {AREA_ORDER.filter((area) => a.needs.some((n) => n.area === area)).map((area) => (
                  <AreaCard key={area} area={area} needs={a.needs.filter((n) => n.area === area)} steps={a.steps} />
                ))}
              </div>
            </Section>
            <Section title="What unlocks next" subtitle="In the order that unlocks the most. Each step: why it matters, how to do it, and what BARRY can do once it's done." plain>
              <SetupPlan steps={a.steps} />
            </Section>
          </>
        )}

        {s && (
          <Section title="What BARRY knows" subtitle="From your business profile." right={<button className={quiet} onClick={() => setShowDetails((v) => !v)}>{showDetails ? "Less" : "Details"}</button>}>
            <Rows rows={[["Business", `${s.identity.data.name} — ${s.identity.data.description}`], ["Goals", s.goals.data.join(", ") || "—"], ["Offers", s.offers.data.offers.length ? s.offers.data.offers.map((o) => `${o.name} (${o.price})`).join(", ") : "none yet"], ["Policies it quotes", s.offers.data.knowledge.map((k) => k.topic).join(", ") || "none yet"], ["Your limits", s.authority.data.policies.join(" ") || "no limits set yet"], ["How it sells", s.personality.data.salesStyle], ["Handing off to you", s.personality.data.handoff]]} />
            {showDetails && (
              <div className="mt-4 space-y-4 border-t border-[#f2f4f7] pt-4">
                <Rows rows={[["Language", s.identity.data.language], ["Time zone", s.identity.data.timezone], ["Opening hours", s.identity.data.hours], ["Tone", s.personality.data.tone], ["Suggestions", s.personality.data.suggestions], ["Checkout", s.personality.data.checkout], ["Checkout needs", s.personality.data.checkoutDetails]]} />
                {s.authority.data.rules.length > 0 && (
                  <ul className="divide-y divide-[#f2f4f7] text-sm">
                    {s.authority.data.rules.map((rule, i) => (
                      <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span>{rule.capability}</span>
                        <Pill tone={rule.effect === "Never" ? "bad" : rule.effect === "You approve first" ? "warn" : "info"} icon={false}>
                          {rule.effect}
                        </Pill>
                      </li>
                    ))}
                  </ul>
                )}
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#667085]">Systems</p>
                  <ul className="mt-1 divide-y divide-[#f2f4f7] text-sm">
                    {s.stack.data.map((c) => (
                      <li key={c.domain} className="flex items-center justify-between gap-2 py-2">
                        <span className="capitalize">{c.domain}</span>
                        <span className="flex items-center gap-2 text-[12px] text-[#667085]">
                          {c.provider ?? "none"}
                          <Pill tone={c.state === "connected" ? "good" : c.state === "simulated" || c.state === "dry run" ? "warn" : "neutral"}>{c.state.replace(/_/g, " ")}</Pill>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                {r && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#667085]">Readiness test (every requirement, checked against the running system)</p>
                    <ul className="mt-1 divide-y divide-[#f2f4f7]">
                      {r.checks.map((c) => (
                        <li key={c.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{c.label}</p>
                            <p className="text-[13px] text-[#475467]">{c.detail}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="text-[12px] text-[#98a2b3]">{LEVEL_SHORT[c.gate]}</span>
                            <Pill tone={CHECK_TONE[c.status].tone}>{CHECK_TONE[c.status].label}</Pill>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Section>
        )}
      </div>
    </OwnerShell>
  );
}
