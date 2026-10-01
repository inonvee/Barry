"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useOwnerApi } from "@/components/owner/useOwnerApi";
import { OwnerShell } from "@/components/owner/OwnerShell";
import { Section, Skeleton, StateNotice, btn } from "@/components/owner/ui";
import { Disclosure, StatusPill } from "@/components/ds/primitives";
import type { ConnectionView } from "@/lib/connections/status";

/**
 * OWNER SETTINGS — two halves kept apart: the BUSINESS SETUP the owner owns (identity, how BARRY
 * behaves, who may approve) and the TECHNICAL configuration the BARRY team owns (connections,
 * credentials, environment), folded away in the team's words. Credentials are never shown.
 */
function SettingsPage() {
  const api = useOwnerApi();
  const { businessId, call, authorized } = api;
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
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
    return () => {
      cancelled = true;
    };
  }, [businessId, call, authorized]);
  const b = api.business;
  return (
    <OwnerShell api={api} active="settings">
      <div className="flex flex-col gap-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#667085]">Settings · {b?.name ?? "—"}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">Your business, and the technical side</h1>
          <p className="mt-1 text-sm text-[#667085]">What you own is on top. What the BARRY team configures for you is folded below, in their words.</p>
        </div>
        {authorized && (
          <>
            <Section title="Business setup" subtitle="What BARRY knows about you and how it behaves.">
              <dl className="grid gap-x-6 gap-y-2 text-[14px] sm:grid-cols-[12rem_1fr]">
                <dt className="text-[#667085]">Business</dt>
                <dd>{b?.name}</dd>
                <dt className="text-[#667085]">What BARRY may do</dt>
                <dd>
                  Your rules decide what BARRY does on its own and what it asks you first. <Link href="/owner/train" className="underline">Train BARRY ›</Link>
                </dd>
                <dt className="text-[#667085]">Who approves</dt>
                <dd>{api.session?.scope === "operator" ? "The shared operator sign-in (the BARRY team can issue you your own)." : "You, with your own owner sign-in for this business only."}</dd>
                <dt className="text-[#667085]">Testing tools</dt>
                <dd>
                  <Link href="/simulator" className="underline">Customer simulator ›</Link>
                </dd>
              </dl>
            </Section>
            <Section title="BARRY team · technical" subtitle="Connections and configuration the team manages. Nothing here changes how BARRY treats your customers without your rules.">
              <Disclosure summary={connections ? `${connections.length} connected system${connections.length === 1 ? "" : "s"} · open the technical view` : "Connections"} muted>
                {error && <StateNotice tone="bad" title="Couldn't read connections">{error}</StateNotice>}
                {!connections && !error && <Skeleton lines={3} />}
                {connections && (
                  <ul className="divide-y divide-[#f2f4f7]">
                    {connections.map((c) => (
                      <li key={c.capability} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
                        <span className="capitalize">{c.capability}{c.provider ? <span className="text-[#667085]"> · {c.provider}</span> : null}</span>
                        <StatusPill status={c.status !== "connected" && c.status !== "not_configured" ? "blocked" : c.status === "not_configured" ? "not_ready" : c.missing.length ? "attention" : c.simulated ? "simulator" : "ok"}>{c.status === "not_configured" ? "Not configured" : c.status !== "connected" ? c.status : c.missing.length ? "Setup incomplete" : c.simulated ? "Simulated" : "Connected"}</StatusPill>
                      </li>
                    ))}
                  </ul>
                )}
                <Link href="/connections" className={`${btn} mt-3`}>Full technical view ›</Link>
              </Disclosure>
            </Section>
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
