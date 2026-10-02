"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useOwnerApi } from "@/components/owner/useOwnerApi";
import { OwnerShell, WhatsAppCard } from "@/components/owner/OwnerShell";
import { WhatsAppLink } from "@/components/owner/WhatsAppLink";
import { Hero, Panel, PanelHeader } from "@/components/owner/kit";
import type { OwnerChannels } from "@/lib/owner/service";
import { PlanAndValue } from "@/components/owner/PlanAndValue";

/**
 * OWNER SETTINGS — configuration, not another dashboard: the business, who approves, the WhatsApp link
 * and the plan (connected systems have their own page). What the BARRY team configures stays in the team's words, folded.
 * Credentials are never shown.
 */
function SettingsPage() {
  const api = useOwnerApi();
  const { businessId, call, authorized } = api;
  const [channels, setChannels] = useState<OwnerChannels | undefined>(undefined);
  useEffect(() => {
    if (!businessId || !authorized) return;
    let cancelled = false;
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
        <Hero eyebrow={`Settings · ${b?.name ?? "—"}`} title="Your business, your plan, your access." lead="Your WhatsApp link, plan and access. Running the business happens in Today, Work and Money — or by message." />
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
                      Your rules decide what BARRY does on its own and what it asks you first. <Link href="/owner/rules" className="font-medium text-o-accent hover:underline">Rules BARRY follows ›</Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[12px] text-o-muted">Systems</dt>
                    <dd>
                      <Link href="/owner/systems" className="font-medium text-o-accent hover:underline">Connected systems ›</Link>
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
