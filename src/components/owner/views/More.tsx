"use client";

import type { OwnerWorkspace } from "@/lib/owner/service";
import type { useOwnerApi } from "../useOwnerApi";
import { useOwnerLang } from "../lang";
import { LanguageSwitch, OWNER_MORE_GROUPS } from "../OwnerShell";
import { Button, Chip, Group, Lead, PageHeader, Row, SectionLabel } from "../os-ui";

/**
 * MORE — the index of the OS, grouped the way an owner thinks: the business (customers, what BARRY
 * knows), BARRY itself (rules, setup, activity) and the systems around it (connections, plan, settings).
 * One line under each says what's there now, so the index is useful on its own.
 */

type Api = ReturnType<typeof useOwnerApi>;

export function MoreView({ ws, api }: { ws: OwnerWorkspace; api: Api }) {
  const { lang, t } = useOwnerLang();
  const needsYou = ws.conversations.filter((c) => c.status === "needs_you").length;
  const hint: Record<string, string | undefined> = {
    customers: t(`${ws.conversations.length} conversations${needsYou ? ` · ${needsYou} need you` : ""}`, `${ws.conversations.length} שיחות${needsYou ? ` · ${needsYou} צריכים אותך` : ""}`),
    knowledge: t("What BARRY tells customers, and what it doesn't know yet", "מה BARRY אומר ללקוחות, ומה הוא עוד לא יודע"),
    rules: t("What BARRY may do on its own, and what needs you", "מה BARRY רשאי לעשות לבד, ומה צריך אותך"),
    setup: t("What's left before BARRY starts", "מה נשאר לפני ש־BARRY מתחיל"),
    activity: t("Everything BARRY recorded, newest first", "כל מה ש־BARRY רשם, מהחדש לישן"),
    systems: t("What BARRY is connected to — real, test or read-only", "למה BARRY מחובר — אמיתי, בדיקה או קריאה בלבד"),
    plan: ws.plan?.name ? t(`${ws.plan.name} plan`, `תוכנית ${ws.plan.name}`) : t("Your plan and what BARRY is worth", "התוכנית שלך ומה BARRY שווה"),
    settings: t("Language, WhatsApp link and access", "שפה, חיבור לוואטסאפ וגישה"),
  };
  const wa = ws.channels.ownerCommands;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("More", "עוד")} sub={<bdi>{ws.business.name}</bdi>} />
      {OWNER_MORE_GROUPS.map((g) => (
        <section key={g.id} className="flex flex-col gap-2">
          <SectionLabel>{g.title[lang]}</SectionLabel>
          <Group label={g.title[lang]}>
            {g.items.map((n) => (
              <Row key={n.id} testId={`more-${n.id}`} lead={<Lead icon={n.icon} />} title={n.label[lang]} sub={hint[n.id]} href={n.href} />
            ))}
          </Group>
        </section>
      ))}
      <section className="flex flex-col gap-2">
        <SectionLabel>{t("You", "אתה")}</SectionLabel>
        <Group>
          <Row
            lead={<Lead icon="phone" tone={wa === "connected" ? "ok" : "neutral"} />}
            title={t("BARRY on your WhatsApp", "BARRY בוואטסאפ שלך")}
            sub={wa === "connected" ? t("Ask and approve from WhatsApp — same as here", "לשאול ולאשר מוואטסאפ — בדיוק כמו כאן") : wa === "not_linked" ? t("Link your number to talk to BARRY on WhatsApp", "לחבר את המספר שלך כדי לדבר עם BARRY בוואטסאפ") : t("The BARRY team turns this on for you", "צוות BARRY מפעיל את זה בשבילך")}
            chip={<Chip tone={wa === "connected" ? "ok" : "neutral"}>{wa === "connected" ? t("Connected", "מחובר") : wa === "not_linked" ? t("Not linked", "לא מקושר") : t("Not connected", "לא מחובר")}</Chip>}
            href="/owner/settings#whatsapp"
          />
        </Group>
        <div className="mt-1 flex flex-col gap-3 px-1">
          <LanguageSwitch />
          {api.session?.signedIn && <Button kind="quiet" onClick={() => void api.signOut()}>{t("Sign out", "יציאה")}</Button>}
        </div>
      </section>
    </div>
  );
}
