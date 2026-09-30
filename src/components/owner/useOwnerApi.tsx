"use client";

import { useCallback, useEffect, useState } from "react";
import { useBusiness, type BusinessSummary } from "@/components/shell/useBusiness";

export type { BusinessSummary };

/**
 * Owner workspace access: the shared current business + the owner SESSION for it (an httpOnly cookie set by
 * signing in once with that business's owner token — the token is never stored or rendered by the page).
 * `call` changes identity when the session changes, so pages reload after signing in or out.
 */

export type OwnerSession = {
  configured: boolean;
  open: boolean;
  signedIn: boolean;
  scope: "open" | "operator" | "business" | null;
  businessId: string | null;
  authorized: boolean | null;
  setup?: { variable: string; shape: string; note: string; businessIds: string[] };
};

export function useOwnerApi() {
  const { businesses, businessId, setBusinessId, business } = useBusiness();
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    fetch(`/api/owner/session?businessId=${encodeURIComponent(businessId)}`)
      .then((r) => r.json())
      .then((s: OwnerSession) => {
        if (!cancelled) setSession(s);
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, version]);

  const authorized = Boolean(session?.authorized);
  const call = useCallback(
    async <T,>(url: string, init?: { method?: string; body?: unknown }): Promise<T> => {
      const res = await fetch(url, {
        method: init?.method ?? (init?.body ? "POST" : "GET"),
        headers: { "content-type": "application/json" },
        body: init?.body ? JSON.stringify(init.body) : undefined,
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      return data;
    },
    // The session is part of every call's identity: signing in/out reloads the page's data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [authorized, version]
  );

  const signIn = useCallback(
    async (token: string): Promise<string | undefined> => {
      const res = await fetch("/api/owner/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ businessId, token }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setVersion((v) => v + 1);
      return res.ok ? undefined : (data.error ?? "Sign-in failed");
    },
    [businessId]
  );

  const signOut = useCallback(async () => {
    await fetch("/api/owner/session", { method: "DELETE" });
    setVersion((v) => v + 1);
  }, []);

  return { businessId, setBusinessId, businesses, business, session, authorized, call, signIn, signOut };
}

/** The owner workspace header: page title + the owner session for the current business (sign in / out). */
export function OwnerBar({ api, title, subtitle }: { api: ReturnType<typeof useOwnerApi>; title: string; subtitle: string }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const s = api.session;
  const submit = async () => {
    setBusy(true);
    const err = await api.signIn(token);
    setBusy(false);
    setError(err ?? "");
    if (!err) setToken("");
  };
  return (
    <header className="flex flex-col gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#667085]">Owner workspace · {api.business?.name ?? "—"}</p>
        <h1 className="mt-1 text-2xl font-semibold md:text-3xl">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-[#475467]">{subtitle}</p>
      </div>
      {s && !s.configured && !s.open && (
        <div className="rounded-xl border border-[#fecdca] bg-[#fef3f2] p-4 text-sm text-[#7a271a]">
          <p className="font-semibold">Owner access isn&apos;t configured on this deployment.</p>
          <p className="mt-1">Set this environment variable (Preview only), then redeploy — one random token per business, never the founder token:</p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-white p-2 text-xs text-[#344054]">{`${s.setup?.variable}=${s.setup?.shape}`}</pre>
          <p className="mt-1 text-xs">Business ids: {s.setup?.businessIds.join(", ")}</p>
        </div>
      )}
      {s && (s.configured || s.open) && (
        <div className={`flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between ${s.authorized ? "border-[#abefc6] bg-[#f6fef9]" : "border-[#fedf89] bg-[#fffcf5]"}`}>
          <p className="text-sm">
            {s.open ? (
              <span className="font-medium text-[#067647]">● Open (local development — no owner tokens configured)</span>
            ) : s.authorized ? (
              <span className="font-medium text-[#067647]">● Connected as {s.scope === "operator" ? "operator (all businesses)" : `owner of ${api.business?.name ?? api.businessId}`}</span>
            ) : s.signedIn ? (
              <span className="font-medium text-[#b42318]">● Signed in to a different business — this one needs its own owner token</span>
            ) : (
              <span className="font-medium text-[#b54708]">● Not signed in to {api.business?.name ?? "this business"}</span>
            )}
          </p>
          {!s.open && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {!s.authorized && (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                  }}
                >
                  <input aria-label="Owner token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Owner token for this business" autoComplete="off" className="min-w-0 flex-1 rounded-md border border-[#d0d5dd] bg-white px-3 py-1.5 text-sm" />
                  <button disabled={busy || !token.trim()} className="rounded-md bg-[#1d2939] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                    Sign in
                  </button>
                </form>
              )}
              {s.signedIn && (
                <button onClick={() => void api.signOut()} className="rounded-md border border-[#d0d5dd] bg-white px-3 py-1.5 text-sm font-medium text-[#344054]">
                  Sign out
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {error && <p className="text-sm text-[#b42318]">{error}</p>}
    </header>
  );
}
