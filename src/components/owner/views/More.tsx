"use client";

import type { OwnerWorkspace } from "@/lib/owner/service";
import type { useOwnerApi } from "../useOwnerApi";
import { useOwnerLang } from "../lang";
import { LanguageSwitch, OWNER_MORE_GROUPS } from "../OwnerShell";
import { useCallback, useEffect, useState } from "react";
import type { OwnerModeView } from "@/lib/owner/mode";
import { Button, Chip, ConfirmButton, Group, Lead, PageHeader, Row, SectionLabel } from "../os-ui";

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
      <ModeControl api={api} />
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

/** BARRY's real operating mode for this business (read from the controls), and the owner's own pause. */
function ModeControl({ api }: { api: Api }) {
  const { t } = useOwnerLang();
  const { businessId, call } = api;
  const [view, setView] = useState<OwnerModeView | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    call<OwnerModeView>(`/api/owner/mode?businessId=${encodeURIComponent(businessId)}`).then(setView, (e: Error) => setError(e.message));
  }, [businessId, call]);
  useEffect(load, [load]);
  if (!view) return error ? <p className="px-1 text-[13px] text-o-bad" role="alert">{error}</p> : null;
  const act = async (action: "pause" | "resume") => {
    setError("");
    try {
      setView(await call<OwnerModeView>("/api/owner/mode", { body: { businessId, action } }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const label = { paused: t("Paused", "מושהה"), simulator: t("Practice mode", "מצב תרגול"), supervised: t("Supervised", "מפוקח"), live: t("Live", "פעיל") }[view.mode];
  const meaning = {
    paused: view.pausedBy === "founder" ? t("The BARRY team paused BARRY for your business: it answers no one, sends nothing and changes nothing. They resume it with you.", "צוות BARRY השהה את BARRY בעסק שלך: הוא לא עונה, לא שולח ולא משנה כלום. הם יחדשו אותו איתך.") : t("You paused BARRY: it answers no one, sends nothing and changes nothing. Customer messages are kept.", "השהית את BARRY: הוא לא עונה, לא שולח ולא משנה כלום. הודעות לקוחות נשמרות."),
    simulator: t("Practice: BARRY answers, but nothing proactive reaches a customer — follow-ups are test runs.", "תרגול: BARRY עונה, אבל שום דבר יזום לא מגיע ללקוח — מעקבים הם הרצות בדיקה."),
    supervised: t("BARRY answers and prepares; every consequential action and every follow-up waits for you.", "BARRY עונה ומכין; כל פעולה משמעותית וכל מעקב מחכים לך."),
    live: t("BARRY does what your rules allow on its own.", "BARRY עושה לבד מה שהכללים שלך מתירים."),
  }[view.mode];
  return (
    <section className="flex flex-col gap-2" data-testid="mode-control">
      <SectionLabel>{t("BARRY's mode", "המצב של BARRY")}</SectionLabel>
      <Group>
        <Row lead={<Lead icon="shield" tone={view.mode === "paused" ? "warn" : "neutral"} />} title={label} sub={meaning} chip={<Chip tone={view.mode === "paused" ? "warn" : view.mode === "live" ? "ok" : "info"}>{label}</Chip>} />
      </Group>
      <div className="px-1">
        {view.mode === "paused" ? (
          view.pausedBy === "owner" && <Button kind="secondary" onClick={() => void act("resume")}>{t("Resume BARRY", "לחדש את BARRY")}</Button>
        ) : (
          <ConfirmButton label={t("Pause BARRY", "להשהות את BARRY")} confirmLabel={t("Pause now", "להשהות עכשיו")} consequence={t("BARRY stops answering customers, sending and changing anything for this business until you resume it. Nothing is deleted.", "BARRY יפסיק לענות, לשלוח ולשנות כל דבר בעסק הזה עד שתחדש. שום דבר לא נמחק.")} kind="secondary" onConfirm={() => act("pause")} />
        )}
        {error && <p className="mt-2 text-[13px] text-o-bad" role="alert">{error}</p>}
      </div>
    </section>
  );
}
