"use client";

import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { useOwnerApi } from "./useOwnerApi";
import { OwnerShell, type OwnerSection } from "./OwnerShell";
import { Skeleton, StateNotice, btn } from "./ui";
import { Hero, Panel } from "./kit";
import type { OwnerOs } from "@/lib/owner/os-service";

/**
 * One frame for the Owner OS pages (Rules · What BARRY knows · Connected systems · BARRY setup): the shell,
 * a calm header, the owner read model from /api/owner/os, and honest loading / failure / sign-in states.
 */
type Api = ReturnType<typeof useOwnerApi>;

function Frame({ section, eyebrow, title, lead, children }: { section: OwnerSection; eyebrow: string; title: ReactNode; lead: ReactNode; children: (os: OwnerOs, api: Api, reload: () => void) => ReactNode }) {
  const api = useOwnerApi();
  const { businessId, call, authorized } = api;
  const [os, setOs] = useState<OwnerOs | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    if (!businessId || !authorized) return;
    call<OwnerOs>(`/api/owner/os?businessId=${encodeURIComponent(businessId)}`)
      .then((d) => {
        setOs(d);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, [businessId, call, authorized]);
  useEffect(() => load(), [load]);
  const data = authorized && os?.business.id === businessId ? os : null;
  return (
    <OwnerShell api={api} active={section}>
      <div className="flex flex-col gap-6">
        <Hero eyebrow={`${eyebrow} · ${api.business?.name ?? "—"}`} title={title} lead={lead} />
        {authorized && error && (
          <StateNotice tone="bad" title="BARRY couldn't load this right now" action={<button className={btn} onClick={load}>Try again</button>}>
            Nothing changed in your business — the page couldn&apos;t read its records.
          </StateNotice>
        )}
        {authorized && !data && !error && (
          <Panel className="p-5" aria-busy>
            <Skeleton lines={5} />
          </Panel>
        )}
        {data?.unavailable.length ? <StateNotice tone="warn" title="Some records couldn't be read">{data.unavailable.join(", ")} — shown as unknown, never guessed.</StateNotice> : null}
        {data && children(data, api, load)}
      </div>
    </OwnerShell>
  );
}

export function OsPage(props: Parameters<typeof Frame>[0]) {
  return (
    <Suspense fallback={<div className="barry-owner min-h-screen" />}>
      <Frame {...props} />
    </Suspense>
  );
}
