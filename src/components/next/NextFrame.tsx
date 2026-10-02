"use client";

import * as React from "react";
import { AlertCircleIcon } from "lucide-react";
import { useOwnerApi } from "@/components/owner/useOwnerApi";
import { useOwnerLang } from "@/components/owner/lang";
import type { OwnerWorkspace } from "@/lib/owner/service";
import { AppShell, Page } from "@/components/app-shell/AppShell";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle, Input, Skeleton } from "@/components/ui/basics";

/**
 * THE NEXT OWNER UI — the shadcn shell around the SAME owner read model and owner endpoints the current UI uses.
 * It owns: the owner session (sign-in with the business's owner token), reading the workspace, and handing the
 * page a `call` that goes through the owner API (which re-checks authority before any effect). Nothing here is
 * linked from the production owner UI yet.
 */

/** Sections not rebuilt yet still open the current owner UI. */
export const NEXT_HREFS: Record<string, string> = {
  home: "/owner?tab=today",
  ask: "/owner?tab=ask",
  work: "/owner/next/work",
  money: "/owner?tab=money",
  customers: "/owner?tab=customers",
  knowledge: "/owner/knowledge",
  rules: "/owner/rules",
  activity: "/owner?tab=activity",
  systems: "/owner/systems",
  settings: "/owner/settings",
};

export type NextCtx = {
  ws: OwnerWorkspace;
  businessId: string;
  call: ReturnType<typeof useOwnerApi>["call"];
  reload: () => Promise<void>;
};

export function NextFrame({ active, title, children }: { active: string; title: string; children: (ctx: NextCtx) => React.ReactNode }) {
  const api = useOwnerApi();
  const { lang, dir, t } = useOwnerLang();
  const { businessId, call, authorized, session } = api;
  const [loaded, setLoaded] = React.useState<OwnerWorkspace | null>(null);
  const [error, setError] = React.useState("");
  const ws = authorized && loaded?.business.id === businessId ? loaded : null;

  const reload = React.useCallback(async () => {
    if (!businessId) return;
    try {
      setLoaded(await call<OwnerWorkspace>(`/api/owner/workspace?businessId=${encodeURIComponent(businessId)}&window=today&lang=${lang}`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, [businessId, call, lang]);

  // ?business= picks the business (links from WhatsApp and the current UI carry it), as the current UI does.
  React.useEffect(() => {
    const want = new URLSearchParams(window.location.search).get("business");
    if (want && want !== businessId && api.businesses.some((b) => b.id === want)) api.setBusinessId(want);
  }, [api, businessId]);

  React.useEffect(() => {
    if (!businessId || !authorized) return;
    const t0 = setTimeout(() => void reload(), 0);
    return () => clearTimeout(t0);
  }, [businessId, authorized, reload]);

  const name = api.business?.name ?? ws?.business.name ?? "BARRY";
  const needs = ws?.interventions.length;

  return (
    <AppShell
      active={active}
      title={title}
      dir={dir}
      workspace={{ name, detail: "BARRY" }}
      user={{ name: t("Owner", "בעל העסק"), email: name }}
      badges={{ work: needs || undefined }}
      hrefs={NEXT_HREFS}
      onSignOut={() => void api.signOut()}
    >
      <Page>
        {session && !authorized && !session.open ? (
          <SignIn onSignIn={api.signIn} businessName={name} />
        ) : error ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>{t("BARRY couldn't load your business", "BARRY לא הצליח לטעון את העסק")}</AlertTitle>
            <AlertDescription>
              <p>{error}</p>
              <Button variant="outline" size="sm" onClick={() => void reload()}>{t("Try again", "לנסות שוב")}</Button>
            </AlertDescription>
          </Alert>
        ) : ws ? (
          children({ ws, businessId, call, reload })
        ) : (
          <div className="flex flex-col gap-3" aria-busy>
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-9 w-full max-w-md" />
            {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        )}
      </Page>
    </AppShell>
  );
}

function SignIn({ onSignIn, businessName }: { onSignIn: (token: string) => Promise<string | undefined>; businessName: string }) {
  const { t } = useOwnerLang();
  const [token, setToken] = React.useState("");
  const [error, setError] = React.useState<string | undefined>();
  const [busy, setBusy] = React.useState(false);
  return (
    <form
      className="mx-auto mt-10 flex w-full max-w-sm flex-col gap-4 rounded-lg border bg-card p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(await onSignIn(token.trim()));
        setBusy(false);
      }}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{t("Sign in", "כניסה")}</h2>
        <p className="text-sm text-muted-foreground">{t(`Use the owner access code for ${businessName}.`, `קוד הגישה של בעל העסק עבור ${businessName}.`)}</p>
      </div>
      <Input type="password" autoComplete="current-password" placeholder={t("Owner access code", "קוד גישה")} value={token} onChange={(e) => setToken(e.target.value)} aria-label={t("Owner access code", "קוד גישה")} data-testid="next-token" />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy || !token.trim()} data-testid="next-sign-in">{t("Sign in", "כניסה")}</Button>
    </form>
  );
}
