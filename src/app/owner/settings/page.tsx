"use client";

import { Suspense } from "react";
import { useOwnerApi } from "@/components/owner/useOwnerApi";
import { LanguageSwitch, OwnerShell } from "@/components/owner/OwnerShell";
import { useOwnerLang } from "@/components/owner/lang";
import { WhatsAppLink } from "@/components/owner/WhatsAppLink";
import { Button, Group, Lead, PageHeader, Row, SectionLabel } from "@/components/owner/os-ui";

/**
 * SETTINGS — configuration, not another dashboard: language, your WhatsApp link to BARRY, and access.
 * What BARRY may do lives in Rules; systems in Connected systems; the plan in Plan & billing. Credentials
 * are never shown.
 */
function SettingsPage() {
  const api = useOwnerApi();
  const { t } = useOwnerLang();
  const s = api.session;
  return (
    <OwnerShell api={api} active="settings">
      <div className="flex flex-col gap-6">
        <PageHeader back={{ href: "/owner?tab=more", label: t("More", "עוד") }} title={t("Settings", "הגדרות")} sub={<bdi>{api.business?.name}</bdi>} />

        <section className="flex flex-col gap-2">
          <SectionLabel>{t("Language", "שפה")}</SectionLabel>
          <LanguageSwitch />
          <p className="px-1 text-[12.5px] text-o-muted">{t("Saved on this device. BARRY's WhatsApp replies to you follow the language you write in.", "נשמר במכשיר הזה. התשובות של BARRY אליך בוואטסאפ הן בשפה שבה אתה כותב.")}</p>
        </section>

        <section id="whatsapp" className="flex scroll-mt-24 flex-col gap-2">
          <SectionLabel>{t("BARRY on your WhatsApp", "BARRY בוואטסאפ שלך")}</SectionLabel>
          <p className="px-1 text-[13.5px] leading-5 text-o-muted">{t("Your own number, linked to this business only. Ask, approve and stop work from WhatsApp — same records and rules as here.", "המספר שלך, מקושר רק לעסק הזה. לשאול, לאשר ולעצור עבודה מוואטסאפ — אותן רשומות ואותם כללים כמו כאן.")}</p>
          <WhatsAppLink api={api} />
        </section>

        <section className="flex flex-col gap-2">
          <SectionLabel>{t("Access", "גישה")}</SectionLabel>
          <Group>
            <Row lead={<Lead icon="lock" />} title={t("Who approves", "מי מאשר")} sub={s?.scope === "operator" ? t("The shared operator sign-in — the BARRY team can issue you your own.", "כניסת מפעיל משותפת — צוות BARRY יכול להנפיק לך כניסה משלך.") : t("You, with your own sign-in for this business only.", "אתה, עם כניסה משלך לעסק הזה בלבד.")} />
            <Row lead={<Lead icon="shield" />} title={t("What BARRY may do", "מה BARRY רשאי לעשות")} sub={t("Your rules decide what BARRY does on its own", "הכללים שלך קובעים מה BARRY עושה לבד")} href="/owner/rules" />
            <Row lead={<Lead icon="plug" />} title={t("Connected systems", "מערכות מחוברות")} href="/owner/systems" />
            <Row lead={<Lead icon="chat" />} title={t("Customer simulator", "סימולטור לקוחות")} sub={t("Try BARRY as a customer — nothing real happens", "לנסות את BARRY כלקוח — שום דבר אמיתי לא קורה")} href="/simulator" />
          </Group>
          {s?.signedIn && <Button kind="quiet" onClick={() => void api.signOut()}>{t("Sign out", "יציאה")}</Button>}
        </section>
      </div>
    </OwnerShell>
  );
}

export default function OwnerSettingsPage() {
  return (
    <Suspense fallback={<div className="barry-owner min-h-screen" />}>
      <SettingsPage />
    </Suspense>
  );
}
