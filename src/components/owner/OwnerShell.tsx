"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { useOwnerApi } from "./useOwnerApi";
import { useQaStatus } from "@/components/shell/TestShell";
import { StateNotice, btn, primary } from "./ui";

/**
 * THE OWNER PRODUCT'S SHELL — one product, not a set of pages: a calm header with the business, a
 * primary navigation the owner would expect (Today · Inbox · Money · Ask · Train BARRY · Settings),
 * a bottom bar on phones, and the sign-in states in plain words. Testing tools stay one discreet
 * link away and never share this navigation.
 */

export type OwnerSection = "today" | "inbox" | "money" | "ask" | "train" | "settings";

export const OWNER_NAV: { id: OwnerSection; href: string; label: string; short: string }[] = [
  { id: "today", href: "/owner?tab=today", label: "Today", short: "Today" },
  { id: "inbox", href: "/owner?tab=inbox", label: "Inbox", short: "Inbox" },
  { id: "money", href: "/owner?tab=money", label: "Money", short: "Money" },
  { id: "ask", href: "/owner?tab=ask", label: "Ask BARRY", short: "Ask" },
  { id: "train", href: "/owner/train", label: "Train BARRY", short: "Train" },
  { id: "settings", href: "/connections", label: "Settings", short: "Settings" },
];

type Api = ReturnType<typeof useOwnerApi>;

export function OwnerShell({ api, active, badge, onNavigate, children }: { api: Api; active: OwnerSection; badge?: Partial<Record<OwnerSection, number>>; onNavigate?: (section: OwnerSection) => boolean | void; children: ReactNode }) {
  const status = useQaStatus(api.businessId);
  const s = api.session;
  const nav = (id: OwnerSection, href: string) => (e: React.MouseEvent) => {
    if (onNavigate?.(id)) e.preventDefault();
    void href;
  };
  return (
    <div className="min-h-screen bg-[#f4f5f7] text-[#101828]">
      <header className="sticky top-0 z-20 border-b border-[#e4e7ec]/80 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
          <Link href="/owner" className="shrink-0 text-[15px] font-bold tracking-tight">
            BARRY
          </Link>
          <nav className="hidden min-w-0 flex-1 items-center gap-0.5 md:flex" aria-label="Owner">
            {OWNER_NAV.map((n) => (
              <Link key={n.id} href={n.href} onClick={nav(n.id, n.href)} className={`relative whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium ${active === n.id ? "bg-[#1d2939] text-white" : "text-[#475467] hover:bg-[#f2f4f7]"}`} aria-current={active === n.id ? "page" : undefined}>
                {n.label}
                {badge?.[n.id] ? <span className={`ml-1.5 rounded-full px-1.5 text-[11px] ${active === n.id ? "bg-white/20 text-white" : "bg-[#b42318] text-white"}`}>{badge[n.id]}</span> : null}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {api.businesses.length > 1 ? (
              <label className="flex min-w-0 items-center gap-1.5 text-[12px] text-[#667085]">
                <span className="hidden sm:inline">Business</span>
                <select aria-label="Current business" value={api.businessId} onChange={(e) => api.setBusinessId(e.target.value)} className="max-w-[11rem] truncate rounded-lg border border-[#d0d5dd] bg-white px-2 py-1.5 text-[13px] font-medium text-[#101828]">
                  {api.businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="truncate text-[13px] font-medium">{api.business?.name}</span>
            )}
            <span className={`hidden h-2 w-2 shrink-0 rounded-full sm:block ${s?.authorized || s?.open ? "bg-[#12b76a]" : "bg-[#f79009]"}`} title={s?.authorized || s?.open ? "Signed in" : "Not signed in"} />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-4 pb-24 pt-4 md:pb-10 md:pt-6">
        <SessionState api={api} />
        {children}
        <footer className="mt-10 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#98a2b3]">
          <span>
            {status?.build.commit ? `Build ${status.build.commit.slice(0, 7)}` : "Local build"}
            {status ? ` · ${status.environment}` : ""}
            {status?.reasoner.mode && status.reasoner.mode !== "live model" ? " · AI simulator" : ""}
          </span>
          <Link href="/simulator" className="hover:text-[#475467]">
            Testing tools ›
          </Link>
        </footer>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-6 border-t border-[#e4e7ec] bg-white/95 backdrop-blur md:hidden" aria-label="Owner">
        {OWNER_NAV.map((n) => (
          <Link key={n.id} href={n.href} onClick={nav(n.id, n.href)} className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${active === n.id ? "text-[#101828]" : "text-[#667085]"}`} aria-current={active === n.id ? "page" : undefined}>
            <span className={`h-1 w-6 rounded-full ${active === n.id ? "bg-[#1d2939]" : "bg-transparent"}`} />
            {n.short}
            {badge?.[n.id] ? <span className="absolute right-3 top-2 rounded-full bg-[#b42318] px-1.5 text-[10px] text-white">{badge[n.id]}</span> : null}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** Sign-in states in the owner's words. Nothing of a business is shown without that business's owner session. */
function SessionState({ api }: { api: Api }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const s = api.session;
  if (!s) return null;
  const submit = async () => {
    setBusy(true);
    const err = await api.signIn(token);
    setBusy(false);
    setError(err ?? "");
    if (!err) setToken("");
  };
  if (!s.configured && !s.open) {
    return (
      <div className="mb-4">
        <StateNotice tone="warn" title="Owner sign-in isn't set up on this deployment yet">
          Ask the BARRY team to issue an owner token for {api.business?.name ?? "your business"}. Until then nothing of the business is shown here.
          <details className="mt-2 text-xs text-[#667085]">
            <summary className="cursor-pointer">Setup details for the BARRY team</summary>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-white p-2 text-[11px] text-[#344054]">{`${s.setup?.variable}=${s.setup?.shape}`}</pre>
            <p className="mt-1">Business ids: {s.setup?.businessIds.join(", ")}</p>
          </details>
        </StateNotice>
      </div>
    );
  }
  if (s.open || s.authorized) {
    return s.signedIn && !s.open ? (
      <div className="mb-3 flex items-center justify-between text-xs text-[#667085]">
        <span>Signed in as {s.scope === "operator" ? "operator" : `the owner of ${api.business?.name ?? api.businessId}`}</span>
        <button onClick={() => void api.signOut()} className="rounded-md px-2 py-1 hover:bg-[#f2f4f7]">
          Sign out
        </button>
      </div>
    ) : null;
  }
  const wrong = s.signedIn;
  return (
    <div className="mb-4">
      <StateNotice
        tone={wrong ? "bad" : "warn"}
        title={wrong ? `You're signed in to a different business` : `Sign in to see ${api.business?.name ?? "this business"}`}
        action={
          <form
            className="flex w-full gap-2 sm:w-auto"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input aria-label="Owner token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Owner token" autoComplete="off" className="min-h-10 min-w-0 flex-1 rounded-lg border border-[#d0d5dd] bg-white px-3 text-sm sm:w-56" />
            <button disabled={busy || !token.trim()} className={primary}>
              Sign in
            </button>
            {wrong && (
              <button type="button" onClick={() => void api.signOut()} className={btn}>
                Sign out
              </button>
            )}
          </form>
        }
      >
        {wrong ? `${api.business?.name ?? "This business"} needs its own owner token. Switch business above, or sign in with this business's token.` : "Your owner token opens only this business — nothing else is shown until you sign in."}
        {error && <p className="mt-1 text-[#b42318]">{error}</p>}
      </StateNotice>
    </div>
  );
}
