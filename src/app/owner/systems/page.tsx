"use client";

import { useState } from "react";
import { OsPage } from "@/components/owner/OsPage";
import { useOwnerLang } from "@/components/owner/lang";
import { Button, Chip, Disclosure, Field, Group, Lead, Notice, Row, SectionLabel, Sheet, type Tone } from "@/components/owner/os-ui";
import type { IconName } from "@/components/owner/kit";
import type { OwnerSystem, SystemLabel } from "@/lib/owner/os";
import { ago } from "@/lib/owner/lang";

/**
 * CONNECTED SYSTEMS — what BARRY works through, one compact row each with an honest label: REAL,
 * SIMULATED (BARRY's simulator — nothing real happens), READ-ONLY, SUPERVISED, TEST MODE, UNAVAILABLE,
 * NOT CONNECTED. The sheet says what BARRY can read and do through it (from the capabilities the system
 * really provides) and what's missing before a supervised start. Credentials are never shown; the BARRY
 * team connects systems.
 */
const LABEL_TONE: Record<SystemLabel, Tone> = { REAL: "ok", SUPERVISED: "info", "READ-ONLY": "info", SIMULATED: "warn", "TEST MODE": "warn", UNAVAILABLE: "bad", "NOT CONNECTED": "neutral" };
const HEALTH: Record<OwnerSystem["health"], [string, string]> = { healthy: ["Working", "עובד"], degraded: ["Setup incomplete", "הגדרה חלקית"], down: ["Not working", "לא עובד"], not_set_up: ["Not set up", "לא הוגדר"] };
const ICON: Record<string, IconName> = { whatsapp_customers: "chat", whatsapp_owner: "phone", understanding: "barry", commerce: "cart", payments: "card", scheduling: "clock", messaging: "send", support: "users", crm: "book" };

export default function SystemsPage() {
  return (
    <OsPage section="systems" title={{ en: "Connected systems", he: "מערכות מחוברות" }} sub={{ en: "What BARRY works through — and whether it's real, a test, or BARRY's simulator.", he: "דרך מה BARRY עובד — והאם זה אמיתי, בדיקה, או הסימולטור של BARRY." }}>
      {(os) => <Systems systems={os.systems} />}
    </OsPage>
  );
}

function Systems({ systems }: { systems: OwnerSystem[] }) {
  const { lang, t } = useOwnerLang();
  const [open, setOpen] = useState<OwnerSystem | null>(null);
  const used = systems.filter((s) => s.used);
  const unused = systems.filter((s) => !s.used);
  const row = (s: OwnerSystem) => (
    <Row
      key={s.id}
      id={s.id}
      testId="system-row"
      lead={<Lead icon={ICON[s.id] ?? "plug"} tone={LABEL_TONE[s.label]} />}
      title={s.name}
      sub={`${s.provider ?? t("No provider", "אין ספק")} · ${HEALTH[s.health][lang === "he" ? 1 : 0]}`}
      chip={<span data-label={s.label}><Chip tone={LABEL_TONE[s.label]}>{s.labelWords}</Chip></span>}
      onClick={() => setOpen(s)}
    />
  );
  const sim = used.some((s) => s.label === "SIMULATED");
  return (
    <>
      {sim && <Notice tone="warn">{t("Some systems run on BARRY's simulator: nothing real reaches customers, stock or money through them.", "חלק מהמערכות רצות על הסימולטור של BARRY: שום דבר אמיתי לא מגיע דרכן ללקוחות, למלאי או לכסף.")}</Notice>}
      <section className="flex flex-col gap-2">
        <SectionLabel>{t("Used by your business", "בשימוש בעסק שלך")}</SectionLabel>
        <Group>{used.map(row)}</Group>
      </section>
      {unused.length > 0 && (
        <div className="o-group px-4">
          <Disclosure summary={t(`Not used by your business (${unused.length})`, `לא בשימוש בעסק שלך (${unused.length})`)}>
            <div className="-mx-4">{unused.map(row)}</div>
          </Disclosure>
        </div>
      )}
      <p className="px-1 text-[12.5px] text-o-faint">{t("The BARRY team connects systems with you — credentials are never shown here.", "צוות BARRY מחבר את המערכות איתך — פרטי גישה אף פעם לא מוצגים כאן.")}</p>
      {open && <SystemSheet s={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function SystemSheet({ s, onClose }: { s: OwnerSystem; onClose: () => void }) {
  const { lang, t } = useOwnerLang();
  return (
    <Sheet open onClose={onClose} title={s.name} testId="system-sheet" footer={s.id === "whatsapp_owner" && s.label === "NOT CONNECTED" ? <Button kind="primary" full href="/owner/settings#whatsapp">{t("Link your WhatsApp", "לקשר את הוואטסאפ שלך")}</Button> : undefined}>
      <div className="flex flex-col gap-4">
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-o-muted"><span data-label={s.label}><Chip tone={LABEL_TONE[s.label]}>{s.labelWords}</Chip></span>{s.provider ?? t("No provider", "אין ספק")}</p>
        <p className="text-[15px] leading-6 text-o-ink">{s.meaning}</p>
        <dl className="flex flex-col gap-3">
          {s.reads.length > 0 && <Field label={t("BARRY can read", "BARRY יכול לקרוא")}><ul className="flex flex-col gap-0.5">{s.reads.map((r) => <li key={r}>{r}</li>)}</ul></Field>}
          {s.does.length > 0 && <Field label={s.label === "SIMULATED" ? t("BARRY can do — on the simulator only", "BARRY יכול לעשות — רק בסימולטור") : t("BARRY can do — within your rules", "BARRY יכול לעשות — בתוך הכללים שלך")}><ul className="flex flex-col gap-0.5">{s.does.map((r) => <li key={r}>{r}</li>)}</ul></Field>}
          <Field label={t("Status", "מצב")}>{HEALTH[s.health][lang === "he" ? 1 : 0]}{s.lastCheck ? ` · ${t("checked", "נבדק")} ${ago(lang, s.lastCheck)}` : ""}</Field>
        </dl>
        {s.missingForLaunch.length > 0 && (
          <Notice tone="warn">
            <span className="block font-medium text-o-ink">{t("Missing before a supervised start", "חסר לפני התחלה מפוקחת")}</span>
            {s.missingForLaunch.map((m) => <span key={m} className="block">{m}</span>)}
          </Notice>
        )}
      </div>
    </Sheet>
  );
}
