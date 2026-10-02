"use client";

import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { useOwnerApi } from "./useOwnerApi";
import { OwnerShell, type OwnerSection } from "./OwnerShell";
import { useOwnerLang } from "./lang";
import { ErrorState, LoadingRows, Notice, PageHeader } from "./os-ui";
import type { OwnerOs } from "@/lib/owner/os-service";

/**
 * One frame for the deep Owner OS pages (Rules · What BARRY knows · Connected systems · BARRY setup): the
 * shell, a header with a way back to More, the owner read model from /api/owner/os in the owner's language,
 * and honest loading / failure states. Signed-out visitors see the sign-in, never the business.
 */
type Api = ReturnType<typeof useOwnerApi>;
type Words = { en: string; he: string };

function Frame({ section, title, sub, children }: { section: OwnerSection; title: Words; sub: Words; children: (os: OwnerOs, api: Api, reload: () => void) => ReactNode }) {
  const api = useOwnerApi();
  const { lang, t, adopt } = useOwnerLang();
  const { businessId, call, authorized } = api;
  const [os, setOs] = useState<OwnerOs | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    if (!businessId || !authorized) return;
    call<OwnerOs>(`/api/owner/os?businessId=${encodeURIComponent(businessId)}&lang=${lang}`)
      .then((d) => {
        setOs(d);
        setError("");
        adopt(d.business.locale);
      })
      .catch((e: Error) => setError(e.message));
  }, [businessId, call, authorized, lang, adopt]);
  useEffect(() => load(), [load]);
  const data = authorized && os?.business.id === businessId ? os : null;
  return (
    <OwnerShell api={api} active={section}>
      <div className="flex flex-col gap-6">
        <PageHeader back={{ href: "/owner?tab=more", label: t("More", "עוד") }} title={title[lang]} sub={sub[lang]} />
        {authorized && error && <ErrorState title={t("BARRY couldn't load this right now", "BARRY לא הצליח לטעון את זה כרגע")} detail={error} onRetry={load} />}
        {authorized && !data && !error && <LoadingRows rows={5} />}
        {data?.unavailable.length ? <Notice tone="warn">{t(`Some records couldn't be read (${data.unavailable.join(", ")}) — shown as unknown, never guessed.`, `חלק מהרשומות לא נקראו (${data.unavailable.join(", ")}) — מוצגות כלא ידועות, בלי לנחש.`)}</Notice> : null}
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
