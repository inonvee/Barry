"use client";

import Link from "next/link";
import { OsPage } from "@/components/owner/OsPage";
import { useOwnerLang } from "@/components/owner/lang";
import { Chevron, Chip, Disclosure, Group, Lead, Row, SectionLabel } from "@/components/owner/os-ui";
import { Icon, type IconName } from "@/components/owner/kit";
import type { OwnerOs } from "@/lib/owner/os-service";
import type { SetupGroupId } from "@/lib/owner/os";

/**
 * BARRY SETUP — a guided journey, not a checklist dump: Meet BARRY → Connect your business → Teach BARRY →
 * Decide what BARRY may do → Supervised start → Earn more autonomy (never automatic). The headline counts
 * what the SERVER's readiness assessment says is left — never a percentage, never computed here. What's
 * left is grouped by who acts (you · connections · the BARRY team · recommended), each item linking to where
 * it's resolved. The BARRY team's release checklist for real customer traffic sits apart, folded.
 */
const STEP = { done: "bg-o-ok text-white", now: "bg-o-accent text-white", later: "bg-o-sunken text-o-faint ring-1 ring-inset ring-o-line" } as const;
const GROUP_ICON: Record<SetupGroupId, IconName> = { owner: "flag", connection: "plug", team: "users", optional: "spark" };
const MODE: Record<OwnerOs["mode"], { en: [string, string]; he: [string, string] }> = {
  simulator: { en: ["Practice", "BARRY works on its simulator — nothing real reaches customers, stock or money."], he: ["תרגול", "BARRY עובד על הסימולטור — שום דבר אמיתי לא מגיע ללקוחות, למלאי או לכסף."] },
  supervised: { en: ["Supervised", "BARRY works with real customers while the BARRY team watches closely; anything above your limits comes to you first."], he: ["מפוקח", "BARRY עובד עם לקוחות אמיתיים וצוות BARRY צמוד; כל מה שמעל הגבולות שלך מגיע אליך קודם."] },
  live: { en: ["On its own, within your rules", "BARRY acts on its own inside your rules; anything above your limits still comes to you first."], he: ["לבד, בתוך הכללים שלך", "BARRY פועל לבד בתוך הכללים שלך; כל מה שמעל הגבולות שלך עדיין מגיע אליך קודם."] },
};

export default function SetupPage() {
  return (
    <OsPage section="setup" title={{ en: "BARRY setup", he: "הגדרת BARRY" }} sub={{ en: "Where BARRY stands, what's left and who does it. BARRY is never called ready without the evidence.", he: "איפה BARRY עומד, מה נשאר ומי עושה את זה. BARRY אף פעם לא מוכרז מוכן בלי הוכחות." }}>
      {(os) => <Setup os={os} />}
    </OsPage>
  );
}

function Setup({ os }: { os: OwnerOs }) {
  const { lang, t } = useOwnerLang();
  const s = os.setup;
  const [modeTitle, modeText] = MODE[os.mode][lang];
  return (
    <>
      <section className="o-group flex flex-col gap-1 px-4 py-4" aria-label={t("Where BARRY stands", "איפה BARRY עומד")}>
        <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-o-muted">{t("Where BARRY stands", "איפה BARRY עומד")}</p>
        <p className="text-[22px] font-semibold leading-tight tracking-tight text-o-ink" data-testid="setup-headline">{s.headline}</p>
        <ol className="mt-3 flex flex-col">
          {s.journey.map((j, i) => {
            const body = (
              <>
                <span className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12.5px] font-semibold ${STEP[j.state]}`}>{j.state === "done" ? <Icon name="check" size={14} /> : i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[15px] font-medium ${j.state === "later" ? "text-o-muted" : "text-o-ink"}`}>{j.title}</span>
                  <span className="block text-[13px] leading-5 text-o-muted">{j.detail}</span>
                </span>
                {j.href && j.state !== "done" && <Chevron className="mt-1.5" />}
              </>
            );
            return <li key={j.id} data-step={j.id} data-state={j.state}>{j.href && j.state !== "done" ? <Link href={j.href} className="-mx-2 flex min-h-12 gap-3 rounded-xl px-2 py-2 hover:bg-o-sunken/50">{body}</Link> : <div className="flex gap-3 py-2">{body}</div>}</li>;
          })}
        </ol>
      </section>

      {s.groups.map((g) => (
        <section key={g.id} className="flex flex-col gap-2" data-group={g.id}>
          <SectionLabel>{`${g.title} · ${g.items.length}`}</SectionLabel>
          <Group>
            {g.items.map((it) => <Row key={it.id} testId="setup-item" lead={<Lead icon={GROUP_ICON[g.id]} tone={g.id === "owner" ? "warn" : g.id === "optional" ? "violet" : "neutral"} />} title={it.label} sub={it.fix ?? it.detail} href={it.href} chip={g.id === "team" ? <Chip>{t("BARRY team", "צוות BARRY")}</Chip> : undefined} />)}
          </Group>
        </section>
      ))}

      <section className="flex flex-col gap-2">
        <SectionLabel>{t("How independent BARRY is", "כמה BARRY עצמאי")}</SectionLabel>
        <div className="o-group flex flex-col gap-3 px-4 py-4">
          <p className="flex flex-wrap items-center gap-2 text-[14.5px] text-o-ink"><Chip tone={os.mode === "simulator" ? "warn" : "info"}>{modeTitle}</Chip></p>
          <p className="text-[14px] leading-6 text-o-ink-2">{modeText}</p>
          <ul className="flex flex-col gap-1.5 text-[13.5px] leading-5 text-o-ink-2">
            <li><Link href="/owner/rules" className="font-medium text-o-accent">{t("Your limits", "הגבולות שלך")}</Link> {t("decide what BARRY does on its own and what it asks you first.", "קובעים מה BARRY עושה לבד ומה הוא שואל אותך קודם.")}</li>
            <li>{t("You approve or decline each request in", "אתה מאשר או דוחה כל בקשה ב־")}<Link href="/owner?tab=work" className="font-medium text-o-accent">{t(" Work", "עבודה")}</Link>{t(" — or by replying to BARRY on WhatsApp.", " — או בתשובה ל־BARRY בוואטסאפ.")}</li>
            <li>{t("Say “Stop all follow-ups” in Ask or on WhatsApp and BARRY stops reaching out at once.", "כתוב ״תעצור את כל המעקבים״ בשאל או בוואטסאפ, ו־BARRY מפסיק לפנות מיד.")}</li>
          </ul>
          <p className="text-[12.5px] leading-5 text-o-muted">{t("More independence is never automatic: after a supervised period, you and the BARRY team decide together.", "יותר עצמאות אף פעם לא אוטומטית: אחרי תקופה מפוקחת, אתה וצוות BARRY מחליטים יחד.")}</p>
        </div>
      </section>

      {s.later.length > 0 && (
        <div className="o-group px-4">
          <Disclosure summary={t(`Before real customer traffic — the BARRY team's checklist (${s.later.length})`, `לפני תנועת לקוחות אמיתית — הרשימה של צוות BARRY (${s.later.length})`)}>
            <ul className="flex flex-col gap-2 pb-2 text-[13.5px] leading-5">
              {s.later.map((l) => <li key={l.id}><span className="font-medium text-o-ink">{l.label}</span> <span className="text-o-muted">— {l.detail}</span></li>)}
            </ul>
          </Disclosure>
        </div>
      )}
    </>
  );
}
