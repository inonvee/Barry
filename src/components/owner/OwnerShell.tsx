"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import type { useOwnerApi } from "./useOwnerApi";
import { PRESENCE_WORD, type OwnerPresence, type PresenceState } from "@/lib/owner/presence-model";
import { useQaStatus } from "@/components/shell/TestShell";
import { StateNotice, btn, input, primary } from "./ui";
import { BarryOrb, Icon, LiveDot, type IconName, type LiveState } from "./kit";
import type { OwnerChannels } from "@/lib/owner/service";

/**
 * THE OWNER CONTROL ROOM SHELL — BARRY runs the business in the background; this is where the owner
 * sees and controls it. A small mental model: TODAY · INBOX · MONEY · BARRY, and everything else under
 * MORE (Actions, Train BARRY, Connections, Plan, Settings). Desktop: a quiet sidebar. Phones: a top
 * bar with BARRY's presence and a five-tab bottom bar. WhatsApp is framed as the everyday command
 * surface — shown with its REAL readiness, never as connected when it isn't.
 */

export type OwnerSection = "today" | "inbox" | "money" | "ask" | "actions" | "train" | "connections" | "plan" | "settings";

type NavItem = { id: OwnerSection; href: string; label: string; short: string; icon: IconName };

export const OWNER_NAV: NavItem[] = [
  { id: "today", href: "/owner?tab=today", label: "Today", short: "Today", icon: "today" },
  { id: "inbox", href: "/owner?tab=inbox", label: "Inbox", short: "Inbox", icon: "inbox" },
  { id: "money", href: "/owner?tab=money", label: "Money", short: "Money", icon: "money" },
  { id: "ask", href: "/owner?tab=ask", label: "Ask BARRY", short: "BARRY", icon: "barry" },
];

export const OWNER_MORE: NavItem[] = [
  { id: "actions", href: "/owner?tab=actions", label: "Actions & approvals", short: "Actions", icon: "shield" },
  { id: "train", href: "/owner/train", label: "Train BARRY", short: "Train", icon: "book" },
  { id: "connections", href: "/connections", label: "Connections", short: "Connections", icon: "plug" },
  { id: "plan", href: "/owner/settings#plan", label: "Plan", short: "Plan", icon: "card" },
  { id: "settings", href: "/owner/settings", label: "Settings", short: "Settings", icon: "settings" },
];

type Api = ReturnType<typeof useOwnerApi>;

const PRESENCE_LIVE: Record<PresenceState, LiveState> = { working: "live", completed: "live", waiting: "waiting", idle: "waiting", needs_you: "attention", degraded: "attention", unavailable: "attention", paused: "off" };

export function OwnerShell({ api, active, badge, onNavigate, presence, channels, children }: { api: Api; active: OwnerSection; badge?: Partial<Record<OwnerSection, number>>; onNavigate?: (section: OwnerSection) => boolean | void; presence?: OwnerPresence; channels?: OwnerChannels; commands?: unknown; children: ReactNode }) {
  const status = useQaStatus(api.businessId);
  const [more, setMore] = useState(false);
  const s = api.session;
  const signedIn = Boolean(s?.authorized || s?.open);
  const click = (id: OwnerSection) => (e: React.MouseEvent) => {
    setMore(false);
    if (onNavigate?.(id)) e.preventDefault();
  };
  const moreActive = OWNER_MORE.some((n) => n.id === active);
  const p = presence ? { live: PRESENCE_LIVE[presence.state], word: PRESENCE_WORD[presence.state] } : undefined;
  useEffect(() => {
    if (!more) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMore(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [more]);

  const navLink = (n: NavItem, compact = false) => (
    <Link
      key={n.id}
      href={n.href}
      onClick={click(n.id)}
      aria-current={active === n.id ? "page" : undefined}
      className={`group relative flex items-center gap-3 rounded-xl px-3 ${compact ? "py-2 text-[13.5px]" : "py-2.5 text-[14px]"} font-medium transition ${active === n.id ? "bg-o-accent/15 text-o-ink ring-1 ring-inset ring-o-accent/30" : "text-o-muted hover:bg-o-sunken hover:text-o-ink"}`}
    >
      <Icon name={n.icon} size={18} className={active === n.id ? "text-o-accent" : "text-o-faint group-hover:text-o-ink-2"} />
      <span className="flex-1">{n.label}</span>
      {badge?.[n.id] ? <span className="rounded-full bg-o-warn px-1.5 text-[11px] font-semibold tabular-nums text-o-on-primary">{badge[n.id]}</span> : null}
    </Link>
  );

  return (
    <div className="barry-owner min-h-screen w-full">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-o-line bg-o-canvas/70 px-3 py-5 backdrop-blur-xl lg:flex">
        <Link href="/owner" className="flex items-center gap-2.5 px-2">
          <BarryOrb size={34} state={presence?.state ?? "idle"} label={presence ? `BARRY · ${PRESENCE_WORD[presence.state]}` : undefined} />
          <span className="text-[17px] font-bold tracking-[0.18em] text-o-ink">BARRY</span>
        </Link>
        <nav className="mt-7 flex flex-col gap-1" aria-label="Primary">
          {OWNER_NAV.map((n) => navLink(n))}
        </nav>
        <p className="mt-6 px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-o-faint">More</p>
        <nav className="mt-1.5 flex flex-col gap-0.5" aria-label="More">
          {OWNER_MORE.map((n) => navLink(n, true))}
        </nav>
        <div className="mt-auto">
          <WhatsAppCard channels={channels} />
          <p className="mt-3 flex items-center justify-between px-2 text-[11px] text-o-faint">
            <span>{status?.build.commit ? `Build ${status.build.commit.slice(0, 7)}` : "Local build"}{status ? ` · ${status.environment}` : ""}</span>
            <Link href="/simulator" className="hover:text-o-ink-2">Testing ›</Link>
          </p>
        </div>
      </aside>

      <div className="lg:pl-64">
        {/* Top bar */}
        <header className="sticky top-0 z-20 border-b border-o-line/70 bg-o-canvas/75 backdrop-blur-xl">
          <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5 md:px-6">
            <Link href="/owner" className="flex items-center gap-2 lg:hidden" aria-label="BARRY home">
              <BarryOrb size={28} state={presence?.state ?? "idle"} />
            </Link>
            <BusinessPicker api={api} />
            <div className="ml-auto flex min-w-0 items-center gap-2">
              {presence && p && (
                <Link href={presence.href ?? "/owner?tab=today"} title={presence.text} className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-o-sunken px-3 py-1.5 text-[12.5px] ring-1 ring-inset ring-o-line transition hover:ring-o-line-strong">
                  <LiveDot state={p.live} />
                  <span className="font-semibold text-o-ink"><span className="hidden sm:inline">BARRY · </span>{p.word}</span>
                  <span className="hidden max-w-[16rem] truncate text-o-muted md:inline">{presence.text}</span>
                </Link>
              )}
              <span className={`h-2 w-2 shrink-0 rounded-full ${signedIn ? "bg-o-ok" : "bg-o-warn"}`} title={signedIn ? "Signed in" : "Not signed in"} />
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl 2xl:max-w-7xl px-4 pb-28 pt-5 md:px-6 md:pt-7 lg:pb-12 overflow-x-clip">
          <SessionState api={api} />
          {children}
        </main>
      </div>

      {/* Phone bottom bar: four surfaces + More */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-o-line bg-o-canvas/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden" aria-label="Primary">
        {OWNER_NAV.map((n) => (
          <Link key={n.id} href={n.href} onClick={click(n.id)} aria-current={active === n.id ? "page" : undefined} className={`relative flex min-h-[60px] flex-col items-center justify-center gap-1 text-[11px] font-medium transition ${active === n.id ? "text-o-ink" : "text-o-faint"}`}>
            <Icon name={n.icon} size={21} className={active === n.id ? "text-o-accent" : ""} />
            {n.short}
            {active === n.id && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-o-accent" />}
            {badge?.[n.id] ? <span className="absolute right-[calc(50%-20px)] top-2 rounded-full bg-o-warn px-1.5 text-[10px] font-semibold text-o-on-primary">{badge[n.id]}</span> : null}
          </Link>
        ))}
        <button onClick={() => setMore(true)} className={`relative flex min-h-[60px] flex-col items-center justify-center gap-1 text-[11px] font-medium ${moreActive ? "text-o-ink" : "text-o-faint"}`} aria-label="More" aria-expanded={more}>
          <Icon name="more" size={21} className={moreActive ? "text-o-accent" : ""} />
          More
          {moreActive && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-o-accent" />}
        </button>
      </nav>

      {more && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/60 backdrop-blur-sm lg:hidden" onClick={() => setMore(false)} role="presentation">
          <div role="dialog" aria-modal="true" aria-label="More" className="o-panel o-rise w-full rounded-t-3xl p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-o-line-strong" />
            <ul className="grid grid-cols-1 gap-1">
              {OWNER_MORE.map((n) => (
                <li key={n.id}>
                  <Link href={n.href} onClick={click(n.id)} className={`flex min-h-12 items-center gap-3 rounded-xl px-3 text-[15px] ${active === n.id ? "bg-o-accent/15 font-semibold text-o-ink" : "text-o-ink-2 hover:bg-o-sunken"}`}>
                    <Icon name={n.icon} size={19} className="text-o-faint" />
                    {n.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-3">
              <WhatsAppCard channels={channels} />
            </div>
            <Link href="/simulator" className="mt-3 block text-center text-[12px] text-o-faint">Testing tools ›</Link>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * WHATSAPP-FIRST FRAMING with the real state. The owner command channel is not connected in this
 * build, so it says so, and points to Ask BARRY; the customer channel shows its actual routing.
 */
export function WhatsAppCard({ channels, wide }: { channels?: OwnerChannels; wide?: boolean }) {
  const owner = channels?.ownerCommands ?? "not_connected";
  const customer = channels?.customerWhatsapp;
  const customerWords: Record<NonNullable<OwnerChannels["customerWhatsapp"]>, { live: LiveState; text: string }> = {
    live: { live: "live", text: "Answering your customers on WhatsApp" },
    dry_run: { live: "waiting", text: "Customer WhatsApp in test mode (nothing is sent)" },
    not_routed: { live: "off", text: "Customer WhatsApp not routed to this business yet" },
    not_configured: { live: "off", text: "Customer WhatsApp not set up yet" },
  };
  const status = owner === "connected" ? `Owner commands: connected ${channels?.ownerNumbers?.join(", ") ?? ""}${channels?.ownerSendMode === "dry_run" ? " (test mode)" : ""}` : owner === "not_linked" ? "Owner commands: ready — link your number" : "Owner commands: not connected yet";
  const lead =
    owner === "connected"
      ? "Message BARRY like your best operator — ask what's happening, start a recovery, approve a request. Everything shows up here too."
      : owner === "not_linked"
        ? "BARRY's owner line is ready. Link your WhatsApp number in Settings and run the business by message."
        : "Soon you'll run BARRY by message. Until the owner channel is connected, ask BARRY here — same records, same rules.";
  return (
    <div className={`rounded-2xl bg-gradient-to-b from-o-accent/12 to-o-violet/8 p-4 ring-1 ring-inset ring-o-accent/20 ${wide ? "h-full" : ""}`}>
      <div className="flex items-center gap-2.5">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#25d366]/15 text-[#25d366] ring-1 ring-inset ring-[#25d366]/30">
          <Icon name="chat" size={18} />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold leading-5 text-o-ink">Message BARRY on WhatsApp</p>
          <p className="text-[12px] text-o-muted">{status}</p>
        </div>
      </div>
      <p className="mt-2.5 text-[12.5px] leading-5 text-o-ink-2">{lead}</p>
      {customer && (
        <p className="mt-2 flex items-center gap-2 text-[12px] text-o-muted">
          <LiveDot state={customerWords[customer].live} />
          {customerWords[customer].text}
        </p>
      )}
      {owner === "connected" && channels?.ownerLine ? (
        <a href={`https://wa.me/${channels.ownerLine}`} target="_blank" rel="noreferrer" className={`${primary} mt-3 w-full`}>
          Open BARRY in WhatsApp
          <Icon name="arrow" size={15} />
        </a>
      ) : owner === "not_linked" ? (
        <Link href="/owner/settings#whatsapp" className={`${btn} mt-3 w-full`}>
          Link WhatsApp
          <Icon name="arrow" size={15} />
        </Link>
      ) : (
        <Link href="/owner?tab=ask" className={`${btn} mt-3 w-full`}>
          Ask BARRY here
          <Icon name="arrow" size={15} />
        </Link>
      )}
    </div>
  );
}

function BusinessPicker({ api }: { api: Api }) {
  if (api.businesses.length <= 1) return <span className="truncate text-[14px] font-semibold text-o-ink">{api.business?.name ?? api.businessId}</span>;
  return (
    <label className="relative flex min-w-0 items-center">
      <span className="sr-only">Current business</span>
      <select value={api.businessId} onChange={(e) => api.setBusinessId(e.target.value)} className="min-h-9 w-full min-w-0 max-w-[13rem] cursor-pointer appearance-none truncate rounded-xl bg-o-sunken py-1.5 pl-3 pr-8 text-[13.5px] font-semibold text-o-ink ring-1 ring-inset ring-o-line transition hover:ring-o-line-strong focus:outline-none focus:ring-2 focus:ring-o-accent">
        {api.businesses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <Icon name="chevron" size={14} className="pointer-events-none absolute right-2.5 rotate-90 text-o-faint" />
    </label>
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
      <div className="mb-5">
        <StateNotice tone="warn" title="Owner sign-in isn't set up on this deployment yet">
          Ask the BARRY team to issue an owner token for {api.business?.name ?? "your business"}. Until then nothing of the business is shown here.
          <details className="mt-2 text-xs text-o-muted">
            <summary className="cursor-pointer">Setup details for the BARRY team</summary>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-o-sunken p-2 text-[11px] text-o-ink-2">{`${s.setup?.variable}=${s.setup?.shape}`}</pre>
            <p className="mt-1">Business ids: {s.setup?.businessIds.join(", ")}</p>
          </details>
        </StateNotice>
      </div>
    );
  }
  if (s.open || s.authorized) {
    return s.signedIn && !s.open ? (
      <div className="mb-4 flex items-center justify-between text-xs text-o-faint">
        <span>Signed in as {s.scope === "operator" ? "operator" : `the owner of ${api.business?.name ?? api.businessId}`}</span>
        <button onClick={() => void api.signOut()} className="rounded-md px-2 py-1 hover:bg-o-sunken hover:text-o-ink-2">
          Sign out
        </button>
      </div>
    ) : null;
  }
  const wrong = s.signedIn;
  return (
    <div className="mb-5">
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
            <input aria-label="Owner token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Owner token" autoComplete="off" className={`${input} min-w-0 flex-1 sm:w-56`} />
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
        {error && <p className="mt-1 text-o-bad">{error}</p>}
      </StateNotice>
    </div>
  );
}
