"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { LANG_COOKIE, dirOf, L, type OwnerLang } from "@/lib/owner/lang";

/**
 * THE OWNER'S LANGUAGE (client) — English or Hebrew, chosen by the owner and kept in a cookie (so the
 * server renders the right language and direction on the next visit, with no flash) and in this browser.
 * A business whose profile is Hebrew starts in Hebrew until the owner chooses. Presentation only: the
 * language never changes what BARRY does.
 */

const STORE = "barry.owner.lang";

type Ctx = { lang: OwnerLang; dir: "rtl" | "ltr"; chosen: boolean; setLang: (l: OwnerLang) => void; adopt: (locale: string | undefined) => void; t: (en: string, he: string) => string };
const LangContext = createContext<Ctx>({ lang: "en", dir: "ltr", chosen: false, setLang: () => undefined, adopt: () => undefined, t: (en) => en });

function persist(l: OwnerLang) {
  try {
    document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    window.localStorage.setItem(STORE, l);
  } catch {
    /* private mode: the choice lasts this visit */
  }
}

export function OwnerLangProvider({ initial, chosen: initiallyChosen, children }: { initial: OwnerLang; chosen: boolean; children: ReactNode }) {
  const [lang, set] = useState<OwnerLang>(initial);
  const [chosen, setChosen] = useState(initiallyChosen);
  const setLang = useCallback((l: OwnerLang) => {
    set(l);
    setChosen(true);
    persist(l);
  }, []);
  // The business's own language is the default until the owner picks one (never overriding a choice).
  const adopt = useCallback(
    (locale: string | undefined) => {
      if (chosen || !locale) return;
      const l: OwnerLang = /^he/i.test(locale) ? "he" : "en";
      if (l !== lang) set(l);
    },
    [chosen, lang],
  );
  const value = useMemo<Ctx>(() => ({ lang, dir: dirOf(lang), chosen, setLang, adopt, t: (en, he) => L(lang, en, he) }), [lang, chosen, setLang, adopt]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export const useOwnerLang = () => useContext(LangContext);
