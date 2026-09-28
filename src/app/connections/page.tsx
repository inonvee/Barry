"use client";

import { useEffect, useState } from "react";
import { OwnerBar, useOwnerApi } from "@/components/owner/useOwnerApi";
import type { ConnectionView } from "@/lib/connections/status";

function statusLabel(c: ConnectionView): { text: string; tone: string } {
  if (c.status === "not_configured") return { text: "Not configured", tone: "bg-[#f2f4f7] text-[#475467]" };
  if (c.status !== "connected") return { text: c.status, tone: "bg-[#fef3f2] text-[#b42318]" };
  if (c.missing.length > 0) return { text: "Setup incomplete", tone: "bg-[#fffaeb] text-[#b54708]" };
  if (c.simulated) return { text: "Simulated (not real)", tone: "bg-[#eff8ff] text-[#175cd3]" };
  return { text: c.lastVerifiedAt ? "Connected" : "Connected, never verified", tone: c.lastVerifiedAt ? "bg-[#ecfdf3] text-[#027a48]" : "bg-[#fffaeb] text-[#b54708]" };
}

export default function ConnectionsPage() {
  const api = useOwnerApi();
  const { businessId, call } = api;
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    call<{ connections: ConnectionView[] }>(`/api/connections?businessId=${encodeURIComponent(businessId)}`)
      .then((data) => {
        if (!cancelled) {
          setConnections(data.connections);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setConnections(null);
          setError(err.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, call]);

  return (
    <main className="min-h-screen bg-[#f7f7f4] px-4 py-6 text-[#171717] md:px-5 md:py-8">
      <section className="mx-auto max-w-5xl space-y-6">
        <OwnerBar
          api={api}
          title="Connections"
          subtitle="What this business is actually connected to. Credentials stay on the server — this page shows only which settings exist, never their values."
        />
        {error && <p className="rounded-md border border-[#fda29b] bg-[#fef3f2] px-4 py-3 text-sm text-[#b42318]">{error}</p>}
        <div className="space-y-4">
          {connections?.map((c) => {
            const label = statusLabel(c);
            return (
              <section key={c.capability} className="rounded-lg border border-[#d0d5dd] bg-white p-4 md:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold capitalize">{c.capability}</h2>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${label.tone}`}>{label.text}</span>
                </div>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-[#667085]">Provider</dt>
                    <dd>{c.provider ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-[#667085]">Configured by</dt>
                    <dd>{c.origin === "business_connection" ? "Business connection" : c.origin === "environment_default" ? "Environment default" : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-[#667085]">Last verified</dt>
                    <dd>{c.lastVerifiedAt ? new Date(c.lastVerifiedAt).toLocaleString() : "Never"}</dd>
                  </div>
                </dl>
                {c.operations.length > 0 && (
                  <p className="mt-2 text-sm text-[#475467]">Can: {c.operations.join(" · ")}</p>
                )}
                {Object.keys(c.settings).length > 0 && (
                  <p className="mt-2 text-sm text-[#475467]">
                    {Object.entries(c.settings)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(" · ")}
                  </p>
                )}
                {c.setup.length > 0 && (
                  <div className="mt-3">
                    <p className="text-sm text-[#667085]">Setup requirements</p>
                    <ul className="mt-1 space-y-1 text-sm">
                      {c.setup.map((s) => (
                        <li key={s.envVar} className="flex items-center gap-2 font-mono text-xs">
                          <span>{s.present ? "✓" : s.required ? "✗" : "○"}</span>
                          <span className="break-all">{s.envVar}</span>
                          <span className="font-sans text-[#667085]">{s.present ? "set" : s.required ? "missing" : "optional"}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {c.status === "not_configured" && (
                  <p className="mt-2 text-sm text-[#475467]">No provider is connected; BARRY will not offer this capability to customers.</p>
                )}
              </section>
            );
          })}
        </div>
      </section>
    </main>
  );
}
