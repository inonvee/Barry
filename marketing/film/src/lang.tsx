import React, {createContext, useContext} from 'react';
import type {Copy} from './i18n/types';

export type Lang = 'he' | 'en';

type Ctx = {lang: Lang; dir: 'rtl' | 'ltr'; sx: 1 | -1; t: Copy; mx: (x: number) => number; fmt: (time: string) => string};

/** Clock times are authored as 24h "HH:MM[:SS]"; the US cut reads them as 12h ("7:03 AM"). Non-times pass through. */
export const formatTime = (lang: Lang, time: string) => {
  const m = time.match(/^(\d{2}):(\d{2})(:\d{2})?$/);
  if (lang !== 'en' || !m) return time;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]}${m[3] ?? ''} ${h < 12 ? 'AM' : 'PM'}`;
};
const LangCtx = createContext<Ctx | null>(null);

export const LangProvider: React.FC<{lang: Lang; copy: Copy; children: React.ReactNode}> = ({lang, copy, children}) => {
  const value: Ctx = {lang, dir: lang === 'he' ? 'rtl' : 'ltr', sx: lang === 'he' ? -1 : 1, t: copy, mx: (x) => (lang === 'he' ? 1920 - x : x), fmt: (time) => formatTime(lang, time)};
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
};

/** `sx` mirrors horizontal motion; `mx` mirrors an absolute stage x (design coords are authored LTR).
 * horizontal motion: +x means "toward the end of the reading direction". */
export const useLang = () => {
  const c = useContext(LangCtx);
  if (!c) throw new Error('LangProvider missing');
  return c;
};
