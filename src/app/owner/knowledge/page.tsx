"use client";

import { useState } from "react";
import { OsPage } from "@/components/owner/OsPage";
import { useOwnerLang } from "@/components/owner/lang";
import { Button, Chip, Disclosure, Field, Group, Lead, Notice, Row, SectionLabel, Sheet, type Tone } from "@/components/owner/os-ui";
import type { useOwnerApi } from "@/components/owner/useOwnerApi";
import type { IconName } from "@/components/owner/kit";
import type { OwnerOs } from "@/lib/owner/os-service";
import type { KnowledgeConcept, KnowledgeItem, NoticedCard } from "@/lib/owner/os";
import { ago } from "@/lib/owner/lang";

/**
 * WHAT BARRY KNOWS — in the owner's concepts (products, delivery, returns, discounts, payment, bookings,
 * hours, support…), never internal keys. First what customers asked that BARRY couldn't answer, then what
 * needs the owner's answer, then everything BARRY answers from, grouped. Each item opens a sheet: what
 * BARRY believes, where it came from, and the one thing the owner can do about it. BARRY never guesses —
 * if it doesn't know, it says so; nothing learned is used until the owner confirms it.
 */

type Api = ReturnType<typeof useOwnerApi>;
const CONCEPT_ICON: Record<KnowledgeConcept, IconName> = { products: "cart", delivery: "send", returns: "receipt", discounts: "spark", payments: "card", bookings: "clock", hours: "today", support: "users", contact: "phone", about: "book", other: "book" };
const STATUS: Record<KnowledgeItem["status"], { tone: Tone; en: string; he: string } | null> = {
  known: null,
  unsure: { tone: "warn", en: "Not confirmed", he: "לא אושר" },
  missing: { tone: "neutral", en: "Doesn't know", he: "לא יודע" },
  needs_answer: { tone: "warn", en: "Needs you", he: "צריך אותך" },
};

export default function KnowledgePage() {
  return (
    <OsPage section="knowledge" title={{ en: "What BARRY knows", he: "מה BARRY יודע" }} sub={{ en: "What BARRY answers customers from, and what only you can tell it. If BARRY doesn't know, it says so.", he: "ממה BARRY עונה ללקוחות, ומה רק אתה יכול לספר לו. כש־BARRY לא יודע — הוא אומר את זה." }}>
      {(os, api, reload) => <Knowledge os={os} api={api} reload={reload} />}
    </OsPage>
  );
}

function Knowledge({ os, api, reload }: { os: OwnerOs; api: Api; reload: () => void }) {
  const { lang, t } = useOwnerLang();
  const [open, setOpen] = useState<KnowledgeItem | null>(null);
  const [asked, setAsked] = useState<NoticedCard | null>(null);
  const attention = os.knowledge.flatMap((g) => g.items).filter((i) => i.status !== "known");
  const itemRow = (i: KnowledgeItem) => {
    const s = STATUS[i.status];
    return <Row key={i.id} testId="knowledge-row" lead={<Lead icon={CONCEPT_ICON[i.concept]} tone={s?.tone ?? "neutral"} />} title={i.title} sub={<bdi dir="auto">{i.belief}</bdi>} chip={s ? <Chip tone={s.tone}>{s[lang]}</Chip> : undefined} onClick={() => setOpen(i)} />;
  };
  return (
    <>
      {os.questions.length > 0 && (
        <section className="flex flex-col gap-2" aria-label={t("Customers asked — BARRY didn't know", "לקוחות שאלו — BARRY לא ידע")}>
          <SectionLabel>{t("Customers asked — BARRY didn't know", "לקוחות שאלו — BARRY לא ידע")}</SectionLabel>
          <Group>
            {os.questions.map((q) => <Row key={q.what} testId="asked-row" lead={<Lead icon="chat" tone="warn" />} title={q.what} sub={q.observation} chip={<Chip tone="warn">{t("Teach", "ללמד")}</Chip>} onClick={() => setAsked(q)} emphasis />)}
          </Group>
        </section>
      )}

      <section id="teach" className="flex scroll-mt-24 flex-col gap-2">
        <SectionLabel>{t("Needs your answer", "מחכה לתשובה שלך")}</SectionLabel>
        {attention.length ? <Group>{attention.map(itemRow)}</Group> : <Notice tone="ok">{t("Nothing missing for what BARRY does today.", "לא חסר כלום למה ש־BARRY עושה היום.")}</Notice>}
      </section>

      {os.knowledge.map((g) => (
        <section key={g.concept} id={g.concept} className="flex scroll-mt-24 flex-col gap-2">
          <SectionLabel>{g.title}</SectionLabel>
          <Group>{g.items.filter((i) => i.status === "known").map(itemRow)}{g.items.every((i) => i.status !== "known") && <Row title={t("Nothing on record yet", "עוד אין כאן מידע")} sub={t("See “Needs your answer” above.", "ראה ״מחכה לתשובה שלך״ למעלה.")} />}</Group>
        </section>
      ))}

      <Sources os={os} api={api} reload={reload} />

      {open && <ItemSheet item={open} api={api} onClose={() => setOpen(null)} onDone={reload} />}
      {asked && <AskedSheet q={asked} api={api} onClose={() => setAsked(null)} onDone={reload} />}
    </>
  );
}

function useSave(api: Api, onDone: () => void) {
  const { t } = useOwnerLang();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (path: string, body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      await api.call(path, { body: { businessId: api.businessId, ...body } });
      setResult({ ok: true, text: ok });
      onDone();
    } catch (e) {
      setResult({ ok: false, text: t(`BARRY didn't save that — nothing changed. (${e instanceof Error ? e.message : "error"})`, `BARRY לא שמר את זה — שום דבר לא השתנה. (${e instanceof Error ? e.message : "error"})`) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, result, save };
}

const inputCls = "min-h-12 w-full rounded-xl bg-o-surface px-4 py-3 text-[16px] leading-6 text-o-ink ring-1 ring-inset ring-o-line-strong placeholder:text-o-faint focus:outline-none focus:ring-2 focus:ring-o-accent";

function ItemSheet({ item, api, onClose, onDone }: { item: KnowledgeItem; api: Api; onClose: () => void; onDone: () => void }) {
  const { lang, t } = useOwnerLang();
  const { busy, result, save } = useSave(api, onDone);
  const [answer, setAnswer] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const a = item.action;
  const s = STATUS[item.status];
  const saved = t("Saved. BARRY uses it from now on.", "נשמר. מעכשיו BARRY משתמש בזה.");
  return (
    <Sheet open onClose={onClose} title={item.title} testId="knowledge-sheet">
      <div className="flex flex-col gap-4">
        {s && <p><Chip tone={s.tone}>{s[lang]}</Chip></p>}
        <p className="whitespace-pre-wrap text-[16px] leading-7 text-o-ink" dir="auto">{item.belief}</p>
        <dl className="flex flex-col gap-3">
          {item.sourceWords && <Field label={t("Where it came from", "מאיפה זה הגיע")}>{item.sourceWords}</Field>}
          {item.detail?.checked && <Field label={t("Last checked", "נבדק לאחרונה")}>{ago(lang, item.detail.checked)}</Field>}
        </dl>
        {a?.kind === "teach" && !result?.ok && (
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (answer.trim()) void save("/api/learnbusiness/answers", { key: a.key, value: answer.trim() }, saved); }}>
            <label className="text-[14px] font-medium text-o-ink" htmlFor="answer">{a.question}</label>
            <textarea id="answer" value={answer} onChange={(e) => setAnswer(e.target.value)} rows={3} dir="auto" placeholder={t("Tell BARRY, like you'd tell a new employee", "ספר ל־BARRY, כמו שהיית מסביר לעובד חדש")} className={inputCls} />
            <Button kind="primary" full type="submit" disabled={busy || !answer.trim()} testId="teach-send">{t("Teach BARRY", "ללמד את BARRY")}</Button>
          </form>
        )}
        {a?.kind === "confirm" && !result?.ok && (
          <div className="flex flex-col gap-2">
            <p className="text-[14px] font-medium text-o-ink" dir="auto">{a.question}</p>
            {correcting ? (
              <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (answer.trim()) void save("/api/learnbusiness/facts", { factId: a.factId, action: "correct", value: answer.trim() }, saved); }}>
                <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} dir="auto" aria-label={t("The correct answer", "התשובה הנכונה")} placeholder={t("The correct answer", "התשובה הנכונה")} className={inputCls} />
                <Button kind="primary" full type="submit" disabled={busy || !answer.trim()}>{t("Save the correction", "לשמור את התיקון")}</Button>
              </form>
            ) : (
              <>
                <Button kind="primary" full disabled={busy} onClick={() => void save("/api/learnbusiness/facts", { factId: a.factId, action: "verify" }, saved)} testId="confirm-yes">{t("Yes, that's right", "כן, זה נכון")}</Button>
                <div className="grid grid-cols-2 gap-2">
                  <Button disabled={busy} onClick={() => setCorrecting(true)}>{t("Correct it", "לתקן")}</Button>
                  <Button kind="quiet" disabled={busy} onClick={() => void save("/api/learnbusiness/facts", { factId: a.factId, action: "reject" }, t("Removed. BARRY won't use it.", "הוסר. BARRY לא ישתמש בזה."))}>{t("Not true", "לא נכון")}</Button>
                </div>
              </>
            )}
          </div>
        )}
        {a?.kind === "choose" && !result?.ok && (
          <div className="flex flex-col gap-2">
            <p className="text-[14px] font-medium text-o-ink">{a.question}</p>
            <Button full disabled={busy} onClick={() => void save("/api/learnbusiness/changes", { changeId: a.changeId, decision: "kept_previous" }, saved)}>{t("Keep mine", "להשאיר את שלי")}: <bdi>{a.previous}</bdi></Button>
            <Button full disabled={busy} onClick={() => void save("/api/learnbusiness/changes", { changeId: a.changeId, decision: "accepted" }, saved)}>{t("Use the new one", "להשתמש בחדש")}: <bdi>{a.proposed}</bdi></Button>
          </div>
        )}
        {a?.kind === "team" && <Notice tone="neutral">{a.words}</Notice>}
        {result && <Notice tone={result.ok ? "ok" : "bad"}>{result.text}</Notice>}
      </div>
    </Sheet>
  );
}

/** A question customers asked that BARRY couldn't answer: the evidence, and the owner's answer as a short note BARRY reads. */
function AskedSheet({ q, api, onClose, onDone }: { q: NoticedCard; api: Api; onClose: () => void; onDone: () => void }) {
  const { t } = useOwnerLang();
  const { busy, result, save } = useSave(api, onDone);
  const [answer, setAnswer] = useState("");
  return (
    <Sheet open onClose={onClose} title={q.what} testId="asked-sheet">
      <div className="flex flex-col gap-4">
        <p className="text-[15px] leading-6 text-o-ink" dir="auto">{q.observation}</p>
        <dl className="flex flex-col gap-3">
          <Field label={t("Why it matters", "למה זה חשוב")}>{q.whyItMatters}</Field>
        </dl>
        <div className="border-y border-o-line">
          <Disclosure summary={t("Evidence", "ראיות")}><p className="text-[13.5px] text-o-ink-2" dir="auto">{q.evidence}</p></Disclosure>
        </div>
        {!result?.ok && (
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (answer.trim()) void save("/api/learnbusiness/sources", { type: "document", name: q.what.slice(0, 80), text: answer.trim(), approved: true }, t("BARRY read your answer. It answers from it once it's clear — anything unclear comes back to you here.", "BARRY קרא את התשובה. הוא יענה ממנה ברגע שהיא ברורה — כל דבר לא ברור יחזור אליך לכאן.")); }}>
            <label htmlFor="asked-answer" className="text-[14px] font-medium text-o-ink">{t("What should BARRY tell customers?", "מה BARRY צריך לענות ללקוחות?")}</label>
            <textarea id="asked-answer" value={answer} onChange={(e) => setAnswer(e.target.value)} rows={3} dir="auto" className={inputCls} />
            <Button kind="primary" full type="submit" disabled={busy || !answer.trim()}>{t("Teach BARRY", "ללמד את BARRY")}</Button>
          </form>
        )}
        {result && <Notice tone={result.ok ? "ok" : "bad"}>{result.text}</Notice>}
      </div>
    </Sheet>
  );
}

/** Where knowledge came from — the owner approves exactly what BARRY reads. */
function Sources({ os, api, reload }: { os: OwnerOs; api: Api; reload: () => void }) {
  const { lang, t } = useOwnerLang();
  const { busy, result, save } = useSave(api, reload);
  const [doc, setDoc] = useState({ name: "", text: "" });
  const KIND: Record<string, [string, string]> = { website: ["Website", "אתר"], catalog: ["Catalog", "קטלוג"], document: ["Document", "מסמך"], connected_system: ["Connected system", "מערכת מחוברת"], owner_facts: ["Your answers", "התשובות שלך"] };
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>{t("Sources", "מקורות")}</SectionLabel>
      {os.sources.length > 0 && (
        <Group>
          {os.sources.map((s) => (
            <Row key={s.id} lead={<Lead icon="book" />} title={<span dir="auto">{s.ref}</span>} sub={`${KIND[s.type]?.[lang === "he" ? 1 : 0] ?? s.type}${s.approvedAt ? ` · ${ago(lang, s.approvedAt)}` : ""}`} chip={<Chip tone={s.status === "fetched" ? (s.freshness === "stale" ? "warn" : "ok") : s.status === "approved" ? "neutral" : "bad"}>{s.status === "fetched" ? (s.freshness === "stale" ? t("Out of date", "לא עדכני") : t("Read", "נקרא")) : s.status === "approved" ? t("Approved", "אושר") : t("Failed", "נכשל")}</Chip>} />
          ))}
        </Group>
      )}
      <div className="o-group px-4">
        <Disclosure summary={t("Give BARRY a document", "לתת ל־BARRY מסמך")}>
          <div className="flex flex-col gap-2 pb-2">
            <input value={doc.name} onChange={(e) => setDoc({ ...doc, name: e.target.value })} dir="auto" aria-label={t("Document name", "שם המסמך")} placeholder={t("Name (e.g. Store policy)", "שם (למשל: מדיניות החנות)")} className={inputCls} />
            <textarea value={doc.text} onChange={(e) => setDoc({ ...doc, text: e.target.value })} rows={4} dir="auto" aria-label={t("Document text", "טקסט המסמך")} placeholder={t("Paste the text", "הדבק את הטקסט")} className={inputCls} />
            <Button disabled={busy || !doc.name.trim() || !doc.text.trim()} onClick={() => void save("/api/learnbusiness/sources", { type: "document", name: doc.name, text: doc.text, approved: true }, t("BARRY read it. New facts wait here for your confirmation.", "BARRY קרא את זה. פרטים חדשים מחכים כאן לאישור שלך.")).then(() => setDoc({ name: "", text: "" }))}>{t("Let BARRY read it", "ש־BARRY יקרא")}</Button>
          </div>
        </Disclosure>
        <Disclosure summary={t("Read from your connected systems", "לקרוא מהמערכות המחוברות")}>
          <div className="flex flex-col gap-2 pb-2">
            <Button disabled={busy} onClick={() => void save("/api/learnbusiness/sources", { type: "catalog", approved: true }, t("BARRY read your catalog.", "BARRY קרא את הקטלוג."))}>{t("Read the connected catalog", "לקרוא את הקטלוג המחובר")}</Button>
            <Button disabled={busy} onClick={() => void save("/api/learnbusiness/sources", { type: "connected_system", approved: true }, t("BARRY read what your systems report.", "BARRY קרא את מה שהמערכות מדווחות."))}>{t("Read what the systems report", "לקרוא את מה שהמערכות מדווחות")}</Button>
          </div>
        </Disclosure>
      </div>
      {result && <Notice tone={result.ok ? "ok" : "bad"}>{result.text}</Notice>}
    </section>
  );
}
