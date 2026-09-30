"use client";

import { useEffect, useState } from "react";
import { OwnerBar, useOwnerApi } from "@/components/owner/useOwnerApi";
import { TestShell } from "@/components/shell/TestShell";
import { Empty, Pill, Section, card, type Tone } from "@/components/owner/ui";
import type { getTrainingProfile } from "@/lib/owner/training";
import type { PilotLevel, ReadinessCheck } from "@/lib/owner/readiness";

type Profile = Awaited<ReturnType<typeof getTrainingProfile>>;

const LEVELS: PilotLevel[] = ["NOT_READY", "READY_FOR_TESTING", "READY_FOR_SUPERVISED_PILOT", "READY_FOR_CUSTOMER_TRAFFIC"];
const LEVEL_SHORT: Record<PilotLevel, string> = { NOT_READY: "Not ready", READY_FOR_TESTING: "Testing", READY_FOR_SUPERVISED_PILOT: "Supervised pilot", READY_FOR_CUSTOMER_TRAFFIC: "Customer traffic" };
const CHECK_TONE: Record<ReadinessCheck["status"], { tone: Tone; label: string }> = { pass: { tone: "good", label: "Done" }, warn: { tone: "warn", label: "Recommended" }, fail: { tone: "bad", label: "Missing" } };

function Missing({ items }: { items: string[] }) {
  if (items.length === 0) return <Pill tone="good">Complete</Pill>;
  return <Pill tone="warn">{`${items.length} to add`}</Pill>;
}

function MissingList({ items }: { items: string[] }) {
  return items.length ? (
    <ul className="mt-3 space-y-1 rounded-lg bg-[#fffaeb] px-3 py-2 text-sm text-[#b54708]">
      {items.map((m) => (
        <li key={m}>• {m}</li>
      ))}
    </ul>
  ) : null;
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
  const { businessId, call } = api;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!businessId) return;
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
  }, [businessId, call]);

  const r = profile?.readiness;
  const s = profile?.sections;
  return (
    <main className="min-h-screen bg-[#f9fafb] text-[#101828]">
      <TestShell active="train" />
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 md:py-10">
        <OwnerBar api={api} title="Train BARRY" subtitle="Everything BARRY knows and is allowed to do for your business — and exactly what's left before customers talk to it." />
        {error && <p className="rounded-lg border border-[#fecdca] bg-[#fef3f2] px-4 py-3 text-sm text-[#b42318]">{error}</p>}
        {!profile && !error && <p className="text-sm text-[#667085]">Loading…</p>}

        {r && (
          <section className={`${card} border-[#1d2939]`}>
            <p className="text-xs font-medium uppercase tracking-wide text-[#667085]">Pilot readiness</p>
            <p className="mt-1 text-2xl font-semibold">{r.label}</p>
            <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Readiness levels">
              {LEVELS.map((l) => {
                const reached = LEVELS.indexOf(l) <= LEVELS.indexOf(r.level);
                return (
                  <li key={l} className={`rounded-lg border px-3 py-2 text-sm ${reached ? "border-[#1d2939] bg-[#1d2939] text-white" : "border-[#e4e7ec] text-[#667085]"}`}>
                    <span aria-hidden>{reached ? "✓ " : ""}</span>
                    {LEVEL_SHORT[l]}
                  </li>
                );
              })}
            </ol>
            {r.next && (
              <div className="mt-5">
                <p className="text-sm font-semibold">
                  To reach “{r.next.label}” — {r.next.blockers.length} thing{r.next.blockers.length === 1 ? "" : "s"} left
                </p>
                <ul className="mt-2 flex flex-col gap-2">
                  {r.next.blockers.map((b) => (
                    <li key={b.id} className="rounded-lg border border-[#fecdca] bg-[#fffbfa] px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold uppercase tracking-wide text-[#101828]">{b.label}</p>
                        <Pill tone="bad">Missing</Pill>
                      </div>
                      <dl className="mt-1 grid grid-cols-1 gap-x-3 gap-y-0.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
                        <dt className="text-[#667085]">What&apos;s missing</dt>
                        <dd className="text-[#344054]">{b.detail}</dd>
                        {b.why && (
                          <>
                            <dt className="text-[#667085]">Why it matters</dt>
                            <dd className="text-[#344054]">{b.why}</dd>
                          </>
                        )}
                        {b.fix && (
                          <>
                            <dt className="text-[#667085]">How to fix it</dt>
                            <dd className="font-medium text-[#b42318]">{b.fix}</dd>
                          </>
                        )}
                      </dl>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {s && (
          <>
            <Section title={`1. ${s.identity.title}`} right={<Missing items={s.identity.missing} />}>
              <Rows rows={[["Name", s.identity.data.name], ["Description", s.identity.data.description], ["Language", s.identity.data.language], ["Time zone", s.identity.data.timezone], ["Opening hours", s.identity.data.hours]]} />
              <MissingList items={s.identity.missing} />
            </Section>
            <Section title={`2. ${s.goals.title}`} right={<Missing items={s.goals.missing} />}>
              {s.goals.data.length ? (
                <div className="flex flex-wrap gap-2">
                  {s.goals.data.map((g) => (
                    <Pill key={g} tone="info" icon={false}>
                      {g}
                    </Pill>
                  ))}
                </div>
              ) : (
                <Empty>No goals yet.</Empty>
              )}
              <MissingList items={s.goals.missing} />
            </Section>
            <Section title={`3. ${s.offers.title}`} right={<Missing items={s.offers.missing} />}>
              <ul className="divide-y divide-[#eaecf0]">
                {s.offers.data.offers.map((o) => (
                  <li key={o.name} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="font-medium">{o.name}</span>
                    <span className="flex items-center gap-2">
                      {o.bookable && <Pill icon={false}>bookable</Pill>}
                      {o.payment && <Pill icon={false}>takes payment</Pill>}
                      <span className="tabular-nums">{o.price}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {s.offers.data.knowledge.length > 0 && <p className="mt-3 text-sm text-[#475467]">Knowledge BARRY may quote: {s.offers.data.knowledge.map((k) => k.topic).join(", ")}</p>}
              {s.offers.data.policies.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-sm text-[#475467]">
                  {s.offers.data.policies.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              <MissingList items={s.offers.missing} />
            </Section>
            <Section title={`4. ${s.stack.title}`} right={<Missing items={s.stack.missing} />}>
              <ul className="divide-y divide-[#eaecf0]">
                {s.stack.data.map((c) => (
                  <li key={c.domain} className="py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium capitalize">{c.domain}</span>
                      <Pill tone={c.state === "connected" ? "good" : c.state === "simulated" || c.state === "dry run" ? "warn" : "neutral"}>{c.state.replace(/_/g, " ")}</Pill>
                    </div>
                    <p className="text-xs text-[#667085]">{c.provider ?? "No provider"}</p>
                    {c.missing.length > 0 && <p className="text-xs text-[#b54708]">Needs: {c.missing.join(", ")}</p>}
                  </li>
                ))}
              </ul>
              <MissingList items={s.stack.missing} />
            </Section>
            <Section title={`5. ${s.capabilities.title}`}>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["Looks up (read only)", s.capabilities.data.read, "neutral"],
                    ["Does on its own", s.capabilities.data.automatic, "info"],
                    ["Does within your limits", s.capabilities.data.conditional, "info"],
                    ["Only with your approval", s.capabilities.data.approval, "warn"],
                    ["Never", s.capabilities.data.never, "bad"],
                  ] as [string, string[], Tone][]
                ).map(([title, items, tone]) => (
                  <div key={title} className="rounded-lg border border-[#eaecf0] p-3">
                    <Pill tone={tone}>{title}</Pill>
                    {items.length ? (
                      <ul className="mt-2 space-y-1 text-sm text-[#344054]">
                        {items.map((i) => (
                          <li key={i}>{i}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-[#98a2b3]">Nothing</p>
                    )}
                  </div>
                ))}
              </div>
            </Section>
            <Section title={`6. ${s.authority.title}`} right={<Missing items={s.authority.missing} />}>
              {s.authority.data.policies.length > 0 ? (
                <ul className="list-disc pl-5 text-sm text-[#344054]">
                  {s.authority.data.policies.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : (
                <Empty>No limits set yet.</Empty>
              )}
              {s.authority.data.rules.length > 0 && (
                <ul className="mt-3 divide-y divide-[#eaecf0] text-sm">
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
              <MissingList items={s.authority.missing} />
            </Section>
            <Section title={`7. ${s.personality.title}`} right={<Missing items={s.personality.missing} />}>
              <Rows rows={[["Tone", s.personality.data.tone], ["Sales style", s.personality.data.salesStyle], ["Suggestions", s.personality.data.suggestions], ["Checkout", s.personality.data.checkout], ["Checkout needs", s.personality.data.checkoutDetails], ["Handoff to a person", s.personality.data.handoff]]} />
              <MissingList items={s.personality.missing} />
            </Section>
            {r && (
              <Section title="8. Readiness test" subtitle="Every requirement, checked against the running system.">
                <ul className="divide-y divide-[#eaecf0]">
                  {r.checks.map((c) => (
                    <li key={c.id} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{c.label}</p>
                        <p className="text-sm text-[#475467]">{c.detail}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-[#98a2b3]">{LEVEL_SHORT[c.gate]}</span>
                        <Pill tone={CHECK_TONE[c.status].tone}>{CHECK_TONE[c.status].label}</Pill>
                      </div>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
