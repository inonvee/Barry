"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
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

export function OwnerShell({ api, active, badge, onNavigate, presence, children }: { api: Api; active: OwnerSection; badge?: Partial<Record<OwnerSection, number>>; onNavigate?: (section: OwnerSection) => boolean | void; presence?: OwnerPresence; children: ReactNode }) {
  const { lang, dir, t } = useOwnerLang();
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
