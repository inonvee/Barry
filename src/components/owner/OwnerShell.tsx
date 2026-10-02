"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { useOwnerApi } from "./useOwnerApi";
import { presenceWord, type OwnerPresence, type PresenceState } from "@/lib/owner/presence-model";
import type { OwnerLang } from "@/lib/owner/lang";
import { BarryOrb, Icon, type IconName } from "./kit";
import { useOwnerLang } from "./lang";
import { Button, Dot, Notice, type Tone } from "./os-ui";

/**
 * THE OWNER OS SHELL — four daily surfaces (Today · Ask · Work · Money) and More, the index of the OS.
 * Phones: a slim top bar (business + BARRY's presence) and a safe-area bottom bar with five tabs.
 * Desktop: a quiet sidebar with the same destinations, grouped. Every destination has English and
 * Hebrew copy; the whole shell carries the owner's language and direction.
 */

export type OwnerSection = "today" | "ask" | "work" | "money" | "more" | "customers" | "rules" | "knowledge" | "systems" | "activity" | "setup" | "plan" | "settings";

export type NavItem = { id: OwnerSection; href: string; label: Record<OwnerLang, string>; short: Record<OwnerLang, string>; icon: IconName };

export const OWNER_NAV: NavItem[] = [
  { id: "today", href: "/owner?tab=today", label: { en: "Today", he: "היום" }, short: { en: "Today", he: "היום" }, icon: "today" },
  { id: "ask", href: "/owner?tab=ask", label: { en: "Ask BARRY", he: "שאל את BARRY" }, short: { en: "Ask", he: "שאל" }, icon: "barry" },
  { id: "work", href: "/owner?tab=work", label: { en: "Work", he: "עבודה" }, short: { en: "Work", he: "עבודה" }, icon: "pulse" },
  { id: "money", href: "/owner?tab=money", label: { en: "Money", he: "כסף" }, short: { en: "Money", he: "כסף" }, icon: "money" },
];
export const MORE_ITEM: NavItem = { id: "more", href: "/owner?tab=more", label: { en: "More", he: "עוד" }, short: { en: "More", he: "עוד" }, icon: "more" };

/** More — the OS index, grouped the way an owner thinks: the business, BARRY, the systems. */
export const OWNER_MORE_GROUPS: { id: string; title: Record<OwnerLang, string>; items: NavItem[] }[] = [
  {
    id: "business",
    title: { en: "Business", he: "העסק" },
    items: [
      { id: "customers", href: "/owner?tab=customers", label: { en: "Customers", he: "לקוחות" }, short: { en: "Customers", he: "לקוחות" }, icon: "inbox" },
      { id: "knowledge", href: "/owner/knowledge", label: { en: "What BARRY knows", he: "מה BARRY יודע" }, short: { en: "Knowledge", he: "ידע" }, icon: "book" },
    ],
  },
  {
    id: "barry",
    title: { en: "BARRY", he: "BARRY" },
    items: [
      { id: "rules", href: "/owner/rules", label: { en: "Rules BARRY follows", he: "הכללים של BARRY" }, short: { en: "Rules", he: "כללים" }, icon: "shield" },
      { id: "setup", href: "/owner/setup", label: { en: "BARRY setup", he: "הגדרת BARRY" }, short: { en: "Setup", he: "הגדרה" }, icon: "check" },
      { id: "activity", href: "/owner?tab=activity", label: { en: "Activity", he: "פעילות" }, short: { en: "Activity", he: "פעילות" }, icon: "clock" },
    ],
  },
  {
    id: "systems",
    title: { en: "Systems", he: "מערכות" },
    items: [
      { id: "systems", href: "/owner/systems", label: { en: "Connected systems", he: "מערכות מחוברות" }, short: { en: "Systems", he: "מערכות" }, icon: "plug" },
      { id: "plan", href: "/owner/plan", label: { en: "Plan & billing", he: "תוכנית וחיוב" }, short: { en: "Plan", he: "תוכנית" }, icon: "card" },
      { id: "settings", href: "/owner/settings", label: { en: "Settings", he: "הגדרות" }, short: { en: "Settings", he: "הגדרות" }, icon: "settings" },
    ],
  },
];
export const OWNER_MORE: NavItem[] = OWNER_MORE_GROUPS.flatMap((g) => g.items);
const MORE_IDS = new Set<OwnerSection>(["more", ...OWNER_MORE.map((n) => n.id)]);

type Api = ReturnType<typeof useOwnerApi>;

export const PRESENCE_TONE: Record<PresenceState, Tone> = { working: "info", completed: "ok", waiting: "neutral", idle: "ok", needs_you: "warn", degraded: "warn", unavailable: "bad", paused: "neutral" };

export type OpsChrome = { syncedAt: Date | null; syncing: boolean; commands: string[]; mode?: string };

export function OwnerShell({ api, active, badge, onNavigate, presence, children, ops }: { api: Api; active: OwnerSection; badge?: Partial<Record<OwnerSection, number>>; onNavigate?: (section: OwnerSection) => boolean | void; presence?: OwnerPresence; children: ReactNode; ops?: OpsChrome }) {
  const { lang, dir, t } = useOwnerLang();
  if (ops) return <OpsShell api={api} active={active} badge={badge} onNavigate={onNavigate} presence={presence} ops={ops}>{children}</OpsShell>;
  const s = api.session;
  const click = (id: OwnerSection) => (e: React.MouseEvent) => {
    if (onNavigate?.(id)) e.preventDefault();
  };
  const moreActive = MORE_IDS.has(active);

  const sideLink = (n: NavItem) => (
    <Link key={n.id} href={n.href} onClick={click(n.id)} aria-current={active === n.id ? "page" : undefined} className={`flex min-h-10 items-center gap-3 rounded-xl px-3 text-[14px] font-medium transition ${active === n.id ? "bg-o-raised text-o-ink ring-1 ring-inset ring-o-line" : "text-o-muted hover:bg-o-sunken hover:text-o-ink"}`}>
      <Icon name={n.icon} size={18} className={active === n.id ? "text-o-accent" : "text-o-faint"} />
      <span className="flex-1">{n.label[lang]}</span>
      {badge?.[n.id] ? <span className="rounded-full bg-o-warn px-1.5 text-[11px] font-semibold tabular-nums text-o-on-primary">{badge[n.id]}</span> : null}
    </Link>
  );

  return (
    <div className="barry-owner min-h-[100dvh] w-full" dir={dir} lang={lang}>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-60 flex-col border-e border-o-line bg-o-canvas px-3 py-5 lg:flex">
        <Link href="/owner?tab=today" className="flex items-center gap-2.5 px-2">
          <BarryOrb size={30} state={presence?.state ?? "idle"} />
          <span className="text-[16px] font-bold tracking-[0.16em] text-o-ink">BARRY</span>
        </Link>
        <nav className="mt-6 flex flex-col gap-0.5" aria-label={t("Primary", "ראשי")}>
          {OWNER_NAV.map(sideLink)}
        </nav>
        {OWNER_MORE_GROUPS.map((g) => (
          <nav key={g.id} className="mt-5 flex flex-col gap-0.5" aria-label={g.title[lang]}>
            <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-o-faint">{g.title[lang]}</p>
            {g.items.map(sideLink)}
          </nav>
        ))}
        <div className="mt-auto px-1">
          <LanguageSwitch compact />
        </div>
      </aside>

      <div className="lg:ps-60">
        {/* Top bar */}
        <header className="sticky top-0 z-20 border-b border-o-line/80 bg-o-canvas/90 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-2.5 px-4 md:px-6">
            <Link href="/owner?tab=today" className="lg:hidden" aria-label={t("BARRY home", "BARRY — דף הבית")}>
              <BarryOrb size={26} state={presence?.state ?? "idle"} />
            </Link>
            <BusinessPicker api={api} />
            {presence && (
              <Link href={presence.href ?? "/owner?tab=today"} title={presence.text} className="ms-auto flex min-h-9 shrink-0 items-center gap-2 rounded-full bg-o-surface px-3 text-[13px] ring-1 ring-inset ring-o-line" data-testid="presence">
                <Dot tone={PRESENCE_TONE[presence.state]} pulse={presence.state === "working"} />
                <span className="font-medium text-o-ink">{presenceWord(presence.state, lang)}</span>
              </Link>
            )}
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl overflow-x-clip px-4 pb-[calc(88px+env(safe-area-inset-bottom))] pt-4 md:px-6 lg:pb-12 lg:pt-6">
          <SessionState api={api} />
          {s && (s.authorized || s.open) ? children : null}
        </main>
      </div>

      {/* Phone bottom bar: four surfaces + More (safe-area aware) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-o-line bg-o-canvas/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden" aria-label={t("Primary", "ראשי")}>
        <div className="mx-auto grid max-w-md grid-cols-5">
          {[...OWNER_NAV, MORE_ITEM].map((n) => {
            const on = n.id === "more" ? moreActive : active === n.id;
            return (
              <Link key={n.id} href={n.href} onClick={click(n.id)} aria-current={on ? "page" : undefined} className={`relative flex h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${on ? "text-o-ink" : "text-o-faint"}`} data-testid={`nav-${n.id}`}>
                {on && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-o-accent" />}
                <Icon name={n.icon} size={22} className={on ? "text-o-accent" : ""} />
                {n.short[lang]}
                {badge?.[n.id] ? <span className="absolute end-[calc(50%-22px)] top-2 min-w-[18px] rounded-full bg-o-warn px-1 text-center text-[10.5px] font-semibold leading-[18px] text-o-on-primary">{badge[n.id]}</span> : null}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

/**
 * THE OPS SHELL (Owner OS art direction, Today first). A hard sidebar, a command layer that answers ⌘K,
 * and a status line that only says "live" because the page really re-reads the records on a timer.
 */
function OpsShell({ api, active, badge, onNavigate, presence, ops, children }: { api: Api; active: OwnerSection; badge?: Partial<Record<OwnerSection, number>>; onNavigate?: (section: OwnerSection) => boolean | void; presence?: OwnerPresence; ops: OpsChrome; children: ReactNode }) {
  const { lang, dir, t, setLang } = useOwnerLang();
  const [palette, setPalette] = useState(false);
  const s = api.session;
  const click = (id: OwnerSection) => (e: React.MouseEvent) => {
    if (onNavigate?.(id)) e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const moreActive = MORE_IDS.has(active);
  const synced = ops.syncedAt ? new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ops.syncedAt) : null;
  const calling = presence?.state === "needs_you";

  return (
    <div className="barry-owner art-ops min-h-[100dvh] w-full" dir={dir} lang={lang}>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-[232px] flex-col border-e border-x-line bg-x-0 px-3 pb-4 pt-5 lg:flex">
        <Link href="/owner?tab=today" className="px-3 text-[15px] font-[650] tracking-[0.22em] text-x-t1">BARRY</Link>
        <p className="mt-1 truncate px-3 text-[12.5px] text-x-t3"><bdi>{api.business?.name ?? ""}</bdi>{ops.mode ? <> · {ops.mode}</> : null}</p>
        <nav className="mt-7 flex flex-col gap-0.5" aria-label={t("Primary", "ראשי")}>
          {OWNER_NAV.map((n) => (
            <Link key={n.id} href={n.href} onClick={click(n.id)} aria-current={active === n.id ? "page" : undefined} className={`flex h-9 items-center gap-3 rounded-[6px] px-3 text-[14px] font-medium ${active === n.id ? "bg-x-2 text-x-t1 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]" : "text-x-t3 hover:bg-x-1 hover:text-x-t1"}`} data-testid={`rail-${n.id}`}>
              <Icon name={n.icon} size={16} className={active === n.id ? "text-x-t1" : "text-x-t4"} />
              <span className="flex-1">{n.label[lang]}</span>
              {badge?.[n.id] ? <span className="x-num min-w-5 rounded-[4px] bg-x-hot/15 px-1.5 text-center text-[11.5px] font-semibold text-x-hot">{badge[n.id]}</span> : null}
            </Link>
          ))}
        </nav>
        <div className="mx-3 my-5 h-px bg-x-line" />
        {OWNER_MORE_GROUPS.map((g) => (
          <nav key={g.id} className="mb-3 flex flex-col" aria-label={g.title[lang]}>
            <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-x-t4">{g.title[lang]}</p>
            {g.items.map((n) => <Link key={n.id} href={n.href} className="flex h-7 items-center rounded-[6px] px-3 text-[13px] text-x-t3 hover:bg-x-1 hover:text-x-t1">{n.label[lang]}</Link>)}
          </nav>
        ))}
        <div className="mt-auto flex items-center gap-1 px-2" role="radiogroup" aria-label={t("Language", "שפה")}>
          {(["en", "he"] as const).map((l) => (
            <button key={l} type="button" role="radio" aria-checked={lang === l} lang={l} onClick={() => setLang(l)} className={`h-7 rounded-[5px] px-2 text-[12.5px] ${lang === l ? "bg-x-2 text-x-t1" : "text-x-t4 hover:text-x-t2"}`} data-testid={`lang-${l}`}>{l === "en" ? "English" : "עברית"}</button>
          ))}
        </div>
      </aside>

      <div className="lg:ps-[232px]">
        {/* Phone header */}
        <header className="sticky top-0 z-20 border-b border-x-line bg-x-0/90 backdrop-blur-md lg:hidden">
          <div className="flex h-12 items-center justify-between gap-3 px-4">
            <Link href="/owner?tab=today" className="flex min-w-0 items-baseline gap-2">
              <span className="text-[14px] font-[650] tracking-[0.22em] text-x-t1">BARRY</span>
              <span className="truncate text-[12.5px] text-x-t3"><bdi>{api.business?.name ?? ""}</bdi></span>
            </Link>
            <div className="flex items-center gap-3">
              <LiveStatus ops={ops} synced={synced} compact />
              <button type="button" onClick={() => setPalette(true)} aria-label={t("Ask BARRY or jump to…", "לשאול את BARRY או לעבור אל…")} className="grid h-8 w-8 place-items-center rounded-[6px] border border-x-line bg-x-1 text-x-t2">
                <Icon name="search" size={15} />
              </button>
            </div>
          </div>
        </header>
        {/* Desktop command layer */}
        <div className="sticky top-0 z-20 hidden h-14 items-center gap-4 border-b border-x-line bg-x-0/85 px-8 backdrop-blur-md lg:flex">
          <button type="button" onClick={() => setPalette(true)} className="flex h-9 w-full max-w-[560px] items-center gap-3 rounded-[7px] border border-x-line bg-x-1 px-3 text-start text-[13.5px] text-x-t3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] hover:border-x-line-2" data-testid="command-bar">
            <Icon name="search" size={15} className="text-x-t4" />
            <span className="flex-1">{t("Ask BARRY or jump to…", "לשאול את BARRY או לעבור אל…")}</span>
            <kbd className="rounded-[4px] border border-x-line-2 px-1.5 text-[11px] text-x-t3">⌘K</kbd>
          </button>
          <div className="ms-auto flex items-center gap-5">
            {presence && <Link href={presence.href ?? "/owner?tab=today"} className={`text-[12.5px] font-medium ${calling ? "text-x-hot" : "text-x-t2"}`} data-testid="presence">{presenceWord(presence.state, lang)}</Link>}
            <LiveStatus ops={ops} synced={synced} />
          </div>
        </div>

        <main className="mx-auto w-full max-w-[1320px] overflow-x-clip px-4 pb-[calc(76px+env(safe-area-inset-bottom))] pt-4 lg:px-8 lg:pb-12 lg:pt-6">
          <SessionState api={api} />
          {s && (s.authorized || s.open) ? children : null}
        </main>
      </div>

      {/* Phone bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-x-line bg-x-0/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden" aria-label={t("Primary", "ראשי")}>
        <div className="grid grid-cols-5">
          {[...OWNER_NAV, MORE_ITEM].map((n) => {
            const on = n.id === "more" ? moreActive : active === n.id;
            return (
              <Link key={n.id} href={n.href} onClick={click(n.id)} aria-current={on ? "page" : undefined} className={`relative flex h-[58px] flex-col items-center justify-center gap-1 text-[11px] font-medium ${on ? "text-x-t1" : "text-x-t4"}`} data-testid={`nav-${n.id}`}>
                <Icon name={n.icon} size={19} />
                {n.short[lang]}
                {badge?.[n.id] ? <span className="x-num absolute end-[calc(50%-20px)] top-2 min-w-4 rounded-[4px] bg-x-hot px-1 text-center text-[10px] font-bold leading-4 text-x-0">{badge[n.id]}</span> : null}
              </Link>
            );
          })}
        </div>
      </nav>

      {palette && <CommandPalette commands={ops.commands} onClose={() => setPalette(false)} />}
    </div>
  );
}

/** "Live" only because the page really re-reads the records on a timer; "Syncing…" while a read is in flight. */
function LiveStatus({ ops, synced, compact }: { ops: OpsChrome; synced: string | null; compact?: boolean }) {
  const { t } = useOwnerLang();
  return (
    <span className="flex items-center gap-2 text-[12.5px] text-x-t3" data-testid="live-status" title={t("BARRY re-reads your records every minute while this page is open", "BARRY קורא מחדש את הרשומות כל דקה כשהדף פתוח")}>
      <span className={`h-1.5 w-1.5 rounded-full ${ops.syncing ? "bg-x-t3" : "bg-x-live"}`} />
      {ops.syncing ? t("Syncing…", "מסתנכרן…") : compact ? <span className="x-num">{synced}</span> : <>{t("Live", "חי")}{synced ? <span className="x-num text-x-t4">· {synced}</span> : null}</>}
    </span>
  );
}

/** ⌘K — ask BARRY anything or jump anywhere. Questions go to Ask (the same command service as WhatsApp). */
function CommandPalette({ commands, onClose }: { commands: string[]; onClose: () => void }) {
  const { lang, t } = useOwnerLang();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const places = [...OWNER_NAV, ...OWNER_MORE].map((n) => ({ kind: "go" as const, label: n.label[lang], href: n.href }));
  const asks = commands.map((c) => ({ kind: "ask" as const, label: c, href: `/owner?tab=ask&q=${encodeURIComponent(c)}` }));
  const needle = q.trim().toLowerCase();
  const items = [
    ...(needle ? [{ kind: "ask" as const, label: q.trim(), href: `/owner?tab=ask&q=${encodeURIComponent(q.trim())}` }] : []),
    ...asks.filter((a) => !needle || a.label.toLowerCase().includes(needle)),
    ...places.filter((p) => !needle || p.label.toLowerCase().includes(needle)),
  ].slice(0, 9);
  const go = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    router.push(it.href);
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-3 pt-[12vh]" role="dialog" aria-modal="true" aria-label={t("Ask BARRY or jump to…", "לשאול את BARRY או לעבור אל…")}>
      <div className="absolute inset-0 bg-[rgba(2,3,5,0.72)] backdrop-blur-[2px]" onClick={onClose} role="presentation" />
      <div className="x-raised relative w-full max-w-[600px] overflow-hidden">
        <div className="flex h-12 items-center gap-3 border-b border-x-line px-4">
          <Icon name="search" size={16} className="text-x-t3" />
          <input
            ref={input}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); go(sel); }
            }}
            dir="auto"
            placeholder={t("Ask BARRY or jump to…", "לשאול את BARRY או לעבור אל…")}
            className="h-full flex-1 bg-transparent text-[15px] text-x-t1 placeholder:text-x-t4 focus:outline-none"
            data-testid="palette-input"
          />
          <kbd className="rounded-[4px] border border-x-line-2 px-1.5 text-[11px] text-x-t3">esc</kbd>
        </div>
        <ul className="max-h-[52vh] overflow-y-auto py-1.5">
          {items.map((it, i) => (
            <li key={`${it.kind}:${it.label}`}>
              <button type="button" onMouseEnter={() => setSel(i)} onClick={() => go(i)} className={`flex h-10 w-full items-center gap-3 px-4 text-start text-[14px] ${i === sel ? "bg-x-3 text-x-t1" : "text-x-t2"}`}>
                <span className="w-12 shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-x-t4">{it.kind === "ask" ? t("Ask", "שאל") : t("Go to", "מעבר")}</span>
                <span className="min-w-0 flex-1 truncate" dir="auto">{it.label}</span>
                {i === sel && <span className="text-[12px] text-x-t4">↵</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function LanguageSwitch({ compact }: { compact?: boolean }) {
  const { lang, setLang, t } = useOwnerLang();
  return (
    <div role="radiogroup" aria-label={t("Language", "שפה")} className={`grid grid-cols-2 gap-1 rounded-xl bg-o-sunken p-1 ring-1 ring-inset ring-o-line ${compact ? "" : "w-full"}`} data-testid="language-switch">
      {(["en", "he"] as const).map((l) => (
        <button key={l} type="button" role="radio" aria-checked={lang === l} onClick={() => setLang(l)} lang={l} className={`min-h-10 rounded-lg px-3 text-[14px] font-medium transition ${lang === l ? "bg-o-raised text-o-ink ring-1 ring-inset ring-o-line-strong" : "text-o-muted hover:text-o-ink"}`} data-testid={`lang-${l}`}>
          {l === "en" ? "English" : "עברית"}
        </button>
      ))}
    </div>
  );
}

function BusinessPicker({ api }: { api: Api }) {
  const { t } = useOwnerLang();
  if (api.businesses.length <= 1) return <span className="min-w-0 truncate text-[15px] font-semibold text-o-ink"><bdi>{api.business?.name ?? api.businessId}</bdi></span>;
  return (
    <label className="relative flex min-w-0 items-center">
      <span className="sr-only">{t("Current business", "העסק הנוכחי")}</span>
      <select value={api.businessId} onChange={(e) => api.setBusinessId(e.target.value)} className="min-h-9 w-full min-w-0 max-w-[12rem] cursor-pointer appearance-none truncate rounded-xl bg-o-surface py-1.5 pe-8 ps-3 text-[14px] font-semibold text-o-ink ring-1 ring-inset ring-o-line focus:outline-none focus:ring-2 focus:ring-o-accent">
        {api.businesses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <Icon name="chevron" size={14} className="pointer-events-none absolute end-2.5 rotate-90 text-o-faint" />
    </label>
  );
}

/** Sign-in states in the owner's words. Nothing of a business is shown without that business's owner session. */
function SessionState({ api }: { api: Api }) {
  const { t } = useOwnerLang();
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const s = api.session;
  if (!s) return null;
  const name = api.business?.name ?? t("this business", "העסק הזה");
  const submit = async () => {
    setBusy(true);
    const err = await api.signIn(token);
    setBusy(false);
    setError(err ?? "");
    if (!err) setToken("");
  };
  if (!s.configured && !s.open) {
    return (
      <div className="mt-6 flex flex-col gap-3">
        <h1 className="text-[22px] font-semibold text-o-ink">{t("Owner sign-in isn't set up yet", "כניסת בעלים עוד לא הוגדרה")}</h1>
        <p className="text-[14.5px] leading-6 text-o-muted">{t(`Ask the BARRY team to issue an owner sign-in for ${name}. Until then nothing of the business is shown here.`, `בקש מצוות BARRY להנפיק כניסת בעלים ל־${name}. עד אז שום דבר מהעסק לא מוצג כאן.`)}</p>
      </div>
    );
  }
  if (s.open || s.authorized) return null;
  const wrong = s.signedIn;
  return (
    <div className="mx-auto mt-8 flex max-w-sm flex-col gap-4">
      <BarryOrb size={52} state="idle" />
      <h1 className="text-[24px] font-semibold leading-tight text-o-ink">{wrong ? t("You're signed in to a different business", "אתה מחובר לעסק אחר") : <>{t("Sign in to ", "כניסה ל־")}<bdi>{name}</bdi></>}</h1>
      <p className="text-[14.5px] leading-6 text-o-muted">{wrong ? t(`${name} needs its own owner sign-in.`, `ל־${name} יש כניסת בעלים משלו.`) : t("Your owner sign-in opens only this business.", "כניסת הבעלים שלך פותחת רק את העסק הזה.")}</p>
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input aria-label={t("Owner token", "קוד בעלים")} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("Owner sign-in code", "קוד כניסת בעלים")} autoComplete="off" dir="ltr" className="min-h-12 w-full rounded-xl bg-o-surface px-4 text-[16px] text-o-ink ring-1 ring-inset ring-o-line placeholder:text-o-faint focus:outline-none focus:ring-2 focus:ring-o-accent" />
        <Button kind="primary" full type="submit" disabled={busy || !token.trim()} testId="sign-in">{t("Sign in", "כניסה")}</Button>
        {wrong && <Button kind="quiet" onClick={() => void api.signOut()}>{t("Sign out", "יציאה")}</Button>}
      </form>
      {error && <Notice tone="bad">{t("That code didn't work for this business.", "הקוד הזה לא מתאים לעסק הזה.")}</Notice>}
    </div>
  );
}
