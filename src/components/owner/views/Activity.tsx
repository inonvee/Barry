"use client";

import { useState } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import { activityTimeline, type TimelineItem } from "@/lib/owner/os";
import { ago, type OwnerLang } from "@/lib/owner/lang";
import type { IconName } from "../kit";
import { useOwnerLang } from "../lang";
import { Empty, Group, Lead, PageHeader, Row, SectionLabel, type Tone } from "../os-ui";

/**
 * ACTIVITY — a trustworthy business timeline, not a log: what BARRY asked you, what you decided, what
 * BARRY did, which payments your provider verified, what BARRY noticed, what you asked BARRY (here or on
 * WhatsApp). Grouped by day; every row opens its record.
 */

const TONE: Record<TimelineItem["tone"], Tone> = { accent: "info", violet: "violet", ok: "ok", warn: "warn", bad: "bad", neutral: "neutral" };

export function ActivityRow({ item, onOpen, lang }: { item: TimelineItem; onOpen: (conversationId: string) => void; lang: OwnerLang }) {
  const sub = [item.sub, ago(lang, item.at)].filter(Boolean).join(" · ");
  return <Row lead={<Lead icon={item.icon as IconName} tone={TONE[item.tone]} />} title={item.text} sub={sub} {...(item.conversationId ? { onClick: () => onOpen(item.conversationId!) } : item.href ? { href: item.href } : {})} />;
}

function dayKey(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function ActivityView({ ws, onOpen }: { ws: OwnerWorkspace; onOpen: (conversationId: string) => void }) {
  const { lang, t } = useOwnerLang();
  const items = activityTimeline(ws, 80, lang);
  const tz = ws.business.timezone;
  const [now] = useState(() => Date.now());
  const today = dayKey(new Date(now).toISOString(), tz);
  const yesterday = dayKey(new Date(now - 864e5).toISOString(), tz);
  const days = [...new Set(items.map((i) => dayKey(i.at, tz)))];
  const dayLabel = (d: string) => (d === today ? t("Today", "היום") : d === yesterday ? t("Yesterday", "אתמול") : new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(new Date(`${d}T12:00:00Z`)));
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("Activity", "פעילות")} sub={t("What happened, from BARRY's records. Payments count only once your provider verifies them.", "מה קרה, מתוך הרשומות של BARRY. תשלום נספר רק אחרי שהספק מאמת אותו.")} back={{ href: "/owner?tab=more", label: t("More", "עוד") }} />
      {items.length === 0 ? (
        <Empty title={t("Nothing yet", "עוד אין כלום")}>{t("Payments, follow-ups, decisions and what you ask BARRY appear here as they happen.", "תשלומים, מעקבים, החלטות ומה ששאלת את BARRY יופיעו כאן ברגע שיקרו.")}</Empty>
      ) : (
        days.map((d) => (
          <section key={d} className="flex flex-col gap-2">
            <SectionLabel>{dayLabel(d)}</SectionLabel>
            <Group>
              {items.filter((i) => dayKey(i.at, tz) === d).map((i) => <ActivityRow key={i.id} item={i} onOpen={onOpen} lang={lang} />)}
            </Group>
          </section>
        ))
      )}
    </div>
  );
}
