"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useOwnerApi } from "@/components/owner/useOwnerApi";
import { OwnerShell, WhatsAppCard } from "@/components/owner/OwnerShell";
import { WhatsAppLink } from "@/components/owner/WhatsAppLink";
import { Pill, Skeleton, StateNotice, btn, type Tone } from "@/components/owner/ui";
import { Hero, IconTile, Panel, PanelHeader, type IconName } from "@/components/owner/kit";
import type { ConnectionView } from "@/lib/connections/status";
import type { OwnerChannels } from "@/lib/owner/service";
import { PlanAndValue } from "@/components/owner/PlanAndValue";

/**
 * OWNER SETTINGS — configuration, not another dashboard: the business, who approves, channels,
 * connected systems, and the plan. What the BARRY team configures stays in the team's words, folded.
 * Credentials are never shown.
 */
function connectionState(c: ConnectionView): { tone: Tone; word: string } {
  if (c.status === "not_configured") return { tone: "neutral", word: "Not configured" };
  if (c.status !== "connected") return { tone: "bad", word: c.status };
  if (c.missing.length) return { tone: "warn", word: "Setup incomplete" };
  if (c.simulated) return { tone: "info", word: "Simulated" };
  return { tone: "good", word: "Connected" };
}

const DOMAIN_ICON: Record<string, IconName> = { commerce: "cart", payments: "money", scheduling: "clock", messaging: "chat" };

function SettingsPage() {
  const api = useOwnerApi();
  const { businessId, call, authorized } = api;
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [channels, setChannels] = useState<OwnerChannels | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!businessId || !authorized) return;
    let cancelled = false;
    call<{ connections: ConnectionView[] }>(`/api/connections?businessId=${encodeURIComponent(businessId)}`)
      .then((d) => {
        if (!cancelled) setConnections(d.connections);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    call<OwnerChannels>(`/api/owner/channels?businessId=${encodeURIComponent(businessId)}`)
      .then((c) => {
        if (!cancelled) setChannels(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [businessId, call, authorized]);
  const b = api.business;
  return (
    <OwnerShell api={api} active="settings" channels={channels}>
      <div className="flex flex-col gap-6">
        <Hero eyebrow={`Settings · ${b?.name ?? "—"}`} title="Your business, your plan, your systems." lead="Configuration lives here. Running the business happens in Today, Inbox and Money — or by message." />
        {authorized && (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Panel className="p-4 md:p-5">
                <PanelHeader icon="settings" title="Business & access" />
                <dl className="mt-3 space-y-3 text-[14px]">
                  <div>
                    <dt className="text-[12px] text-o-muted">Business</dt>
                    <dd className="font-medium text-o-ink">{b?.name}</dd>
                  </div>
                  <div>
                    <dt className="text-[12px] text-o-muted">Who approves</dt>
                    <dd className="text-o-ink-2">{api.session?.scope === "operator" ? "The shared operator sign-in (the BARRY team can issue you your own)." : "You, with your own owner sign-in for this business only."}</dd>
                  </div>
                  <div>
                    <dt className="text-[12px] text-o-muted">What BARRY may do</dt>
                    <dd className="text-o-ink-2">
                      Your rules decide what BARRY does on its own and what it asks you first. <Link href="/owner/train" className="font-medium text-o-accent hover:underline">Train BARRY ›</Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[12px] text-o-muted">Testing tools</dt>
                    <dd>
                      <Link href="/simulator" className="font-medium text-o-accent hover:underline">Customer simulator ›</Link>
                    </dd>
                  </div>
                </dl>
              </Panel>
              <WhatsAppCard channels={channels} wide />
            </div>

            <WhatsAppLink api={api} onChanged={() => void call<OwnerChannels>(`/api/owner/channels?businessId=${encodeURIComponent(businessId)}`).then(setChannels).catch(() => undefined)} />

            <div id="plan" className="flex scroll-mt-24 flex-col gap-5">
              <PlanAndValue api={api} />
            </div>

            <Panel className="p-4 md:p-5">
              <PanelHeader icon="plug" title="Connected systems" sub="What BARRY works through. The BARRY team configures these; nothing here changes how BARRY treats your customers without your rules." right={<Link href="/connections" className={btn}>Technical view</Link>} />
              {error && <div className="mt-3"><StateNotice tone="bad" title="Couldn't read connections">{error}</StateNotice></div>}
              {!connections && !error && <div className="mt-3"><Skeleton lines={3} /></div>}
              {connections && (
                <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {connections.map((c) => {
                    const st = connectionState(c);
                    return (
                      <li key={c.capability} className="flex items-center gap-3 rounded-xl bg-o-sunken/60 px-3 py-2.5 ring-1 ring-inset ring-o-line">
                        <IconTile name={DOMAIN_ICON[c.capability] ?? "plug"} tone={st.tone === "good" ? "ok" : st.tone === "bad" ? "bad" : st.tone === "warn" ? "warn" : "neutral"} size={30} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[14px] font-medium capitalize text-o-ink">{c.capability}</span>
                          <span className="block truncate text-[12px] text-o-muted">{c.provider ?? "No provider"}</span>
                        </span>
                        <Pill tone={st.tone}>{st.word}</Pill>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </>
        )}
      </div>
    </OwnerShell>
  );
}

export default function OwnerSettingsPage() {
  return (
    <Suspense>
      <SettingsPage />
    </Suspense>
  );
}
