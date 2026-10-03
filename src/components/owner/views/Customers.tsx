"use client";

import { useEffect, useState } from "react";
import type { OwnerWorkspace } from "@/lib/owner/service";
import type { OutcomeEvent } from "@/lib/owner/revenue";
import type { ConversationStory } from "@/lib/owner/story";
import type { Intervention } from "@/lib/owner/interventions";
import { ago, amount, type OwnerLang } from "@/lib/owner/lang";
import type { useOwnerApi } from "../useOwnerApi";
import { useOwnerLang } from "../lang";
import { Button, Chip, Disclosure, Empty, ErrorState, Group, LoadingRows, PageHeader, Row, Segments, Sheet, type Tone } from "../os-ui";
import { DecisionRow } from "./decision";
import { CONVERSATION_STATE, LIFECYCLE, conversationState, initial, type ConversationState } from "./shared";

/**
 * CUSTOMERS — operational visibility, not a chat client: who needs you, who BARRY is waiting on, who it
 * is handling, who is done. A row says who, the state, and the last thing that happened; the sheet tells
 * the story first (what they wanted, where it stands, what BARRY did) and keeps the messages one tap away.
 * Customer text is shown exactly as written, bidi-isolated.
 */

type Api = ReturnType<typeof useOwnerApi>;
type Filter = "you" | "customer" | "barry" | "resolved";

type ConversationDetail = {
  id: string;
  customer: string;
  channel: string;
  /** notSent: a BARRY message that never reached the customer (test mode, or the channel refused it). */
  messages: { from: string; text: string; at: string; notSent?: "dry_run" | "failed" }[];
  outcomes: OutcomeEvent[];
  transaction: string[];
  story?: ConversationStory;
  requests: { id: string; what: string; lifecycle: string; createdAt: string }[];
  handoffs: { id: string; reason: string; status: string; urgency: string; summary: string; unresolved: string[] }[];
};

export const OUTCOME: Record<OutcomeEvent["kind"], { tone: Tone; label: Record<OwnerLang, string> }> = {
  paid: { tone: "ok", label: { en: "Paid", he: "שולם" } },
  booked: { tone: "ok", label: { en: "Booked", he: "נקבע" } },
  order_created: { tone: "ok", label: { en: "Order", he: "הזמנה" } },
  case_created: { tone: "info", label: { en: "Case opened", he: "נפתחה פנייה" } },
  checkout_abandoned: { tone: "warn", label: { en: "Checkout not completed", he: "רכישה לא הושלמה" } },
  blocked: { tone: "warn", label: { en: "Stopped", he: "נעצר" } },
  failed: { tone: "bad", label: { en: "Didn't go through", he: "לא הצליח" } },
  handoff: { tone: "info", label: { en: "Handed to your team", he: "הועבר לצוות שלך" } },
  declined_by_owner: { tone: "neutral", label: { en: "You declined", he: "דחית" } },
};
const CHANNEL: Record<string, Record<OwnerLang, string>> = {
  whatsapp: { en: "WhatsApp", he: "וואטסאפ" },
  web: { en: "Web chat", he: "צ׳אט באתר" },
  instagram: { en: "Instagram", he: "אינסטגרם" },
  simulator: { en: "Simulator", he: "סימולטור" },
};
const HANDOFF_STATUS: Record<string, Record<OwnerLang, string>> = { open: { en: "Open", he: "פתוח" }, acknowledged: { en: "Seen by your team", he: "הצוות ראה" }, resolved: { en: "Resolved", he: "טופל" } };

export function CustomersView({ ws, onOpen, onDecision }: { ws: OwnerWorkspace; onOpen: (conversationId: string) => void; onDecision: (item: Intervention) => void }) {
  const { lang, t } = useOwnerLang();
  const rows = ws.conversations.map((c) => ({ c, state: conversationState(c) }));
  const count = (s: ConversationState) => rows.filter((x) => x.state === s).length;
  const [filter, setFilter] = useState<Filter>(() => (count("you") ? "you" : count("barry") ? "barry" : count("customer") ? "customer" : "resolved"));
  const shown = rows.filter((x) => x.state === filter);
  const label = (s: Filter) => ({ you: t("Needs you", "צריך אותך"), customer: t("Waiting", "מחכים"), barry: t("Active", "פעילים"), resolved: t("Done", "הסתיימו") })[s];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader back={{ href: "/owner?tab=more", label: t("More", "עוד") }} title={t("Customers", "לקוחות")} sub={t(`${ws.conversations.length} conversations — who needs you, who BARRY is waiting on, and who is done.`, `${ws.conversations.length} שיחות — מי צריך אותך, למי BARRY מחכה, ומי סיים.`)} />
      <Segments<Filter> ariaLabel={t("Filter customers", "סינון לקוחות")} value={filter} onChange={setFilter} options={(["you", "customer", "barry", "resolved"] as const).map((s) => ({ id: s, label: label(s), count: count(s) }))} />
      {shown.length ? (
        <Group label={label(filter)}>
          {shown.map(({ c, state }) => {
            const st = CONVERSATION_STATE[state];
            const last = c.lastMessage ? `${c.lastMessage.from === "barry" ? "BARRY: " : ""}${c.lastMessage.text}` : CHANNEL[c.channel]?.[lang];
            return (
              <Row
                key={c.id}
                testId="customer-row"
                lead={<span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-o-raised text-[14px] font-semibold text-o-ink-2 ring-1 ring-inset ring-o-line">{initial(c.customer)}</span>}
                title={c.customer}
                sub={<bdi dir="auto">{last}</bdi>}
                chip={<Chip tone={st.tone}>{c.outcomes[0] && state === "resolved" ? OUTCOME[c.outcomes[0]].label[lang] : st.label[lang]}</Chip>}
                endSub={ago(lang, c.lastActivityAt)}
                onClick={() => onOpen(c.id)}
              />
            );
          })}
        </Group>
      ) : (
        <Empty title={ws.conversations.length ? t("No one here", "אין כאן אף אחד") : t("No conversations yet", "עוד אין שיחות")}>
          {ws.conversations.length ? t("No customer is in this state right now.", "אין כרגע לקוח במצב הזה.") : t("When customers write to BARRY, each one shows up here with where things stand.", "כשלקוחות יכתבו ל־BARRY, כל אחד יופיע כאן עם המצב שלו.")}
        </Empty>
      )}
      {filter === "you" && ws.interventions.length > 0 && (
        <p className="px-1 text-[13px] text-o-muted">
          {t("Decisions are also in Work → Needs you.", "ההחלטות נמצאות גם ב״עבודה ← צריך אותך״.")}{" "}
          <button type="button" className="font-medium text-o-accent" onClick={() => onDecision(ws.interventions[0])}>{t("Open the first one", "לפתוח את הראשונה")}</button>
        </p>
      )}
    </div>
  );
}

/** The conversation, over whatever page you're on: the story first, then the messages. */
export function ConversationSheet({ id, ws, api, onClose, onDecision }: { id: string; ws: OwnerWorkspace; api: Api; onClose: () => void; onDecision: (item: Intervention) => void }) {
  const { lang, t } = useOwnerLang();
  const [data, setData] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const { businessId, call } = api;
  useEffect(() => {
    let cancelled = false;
    call<ConversationDetail>(`/api/owner/conversation?businessId=${encodeURIComponent(businessId)}&conversationId=${encodeURIComponent(id)}&lang=${lang}`)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError("");
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, call, id, lang, attempt]);
  const row = ws.conversations.find((c) => c.id === id);
  const state = row ? conversationState(row) : undefined;
  const decisions = ws.interventions.filter((i) => i.conversationId === id);
  const name = data?.customer ?? row?.customer ?? t("Customer", "לקוח");
  return (
    <Sheet open onClose={onClose} title={<bdi>{name}</bdi>} testId="conversation-sheet">
      <div className="flex flex-col gap-4">
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-o-muted">
          {state && <Chip tone={CONVERSATION_STATE[state].tone}>{CONVERSATION_STATE[state].label[lang]}</Chip>}
          {row && <span>{CHANNEL[row.channel]?.[lang]} · {ago(lang, row.lastActivityAt)}</span>}
        </p>
        {decisions.length > 0 && <div className="o-group">{decisions.map((i) => <DecisionRow key={i.id} item={i} onOpen={() => onDecision(i)} />)}</div>}
        {error && <ErrorState title={t("Couldn't open this conversation", "לא הצלחנו לפתוח את השיחה")} detail={error} onRetry={() => setAttempt((a) => a + 1)} />}
        {!data && !error && <LoadingRows rows={3} />}
        {data && (
          <>
            {data.transaction.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-o-muted">{t("Where it stands", "איפה זה עומד")}</h3>
                <ul className="flex flex-col gap-1 text-[14.5px] leading-6 text-o-ink-2">
                  {data.transaction.map((x, i) => <li key={i}><bdi>{x}</bdi></li>)}
                </ul>
              </section>
            )}
            {data.outcomes.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-o-muted">{t("What happened", "מה קרה")}</h3>
                <div className="o-group">
                  {data.outcomes.map((o, i) => (
                    <Row key={i} title={OUTCOME[o.kind].label[lang]} sub={`${ago(lang, o.at)}${o.simulated ? ` · ${t("test", "בדיקה")}` : ""}`} end={o.amount !== undefined && o.currency ? <bdi>{amount(lang, o.amount, o.currency)}</bdi> : undefined} chip={<Chip tone={OUTCOME[o.kind].tone}>{OUTCOME[o.kind].label[lang]}</Chip>} />
                  ))}
                </div>
              </section>
            )}
            {data.handoffs.filter((h) => h.status !== "resolved").map((h) => (
              <div key={h.id} className="rounded-xl bg-o-info-bg px-3.5 py-3 text-[14px] leading-6 text-o-ink-2 ring-1 ring-inset ring-o-info-line">
                <p className="font-medium text-o-ink">{t("Handed to your team", "הועבר לצוות שלך")} · {HANDOFF_STATUS[h.status]?.[lang] ?? h.status}</p>
                <p dir="auto">{h.reason}</p>
              </div>
            ))}
            <div className="divide-y divide-o-line border-y border-o-line">
              {(data.story?.tried.length ?? 0) > 0 && (
                <Disclosure summary={t("What BARRY did", "מה BARRY עשה")}>
                  <ol className="flex flex-col gap-1.5 text-[13.5px] leading-5 text-o-ink-2">
                    {data.story!.tried.map((x, i) => <li key={i}><bdi>{x}</bdi></li>)}
                  </ol>
                </Disclosure>
              )}
              {data.requests.length > 0 && (
                <Disclosure summary={t(`Requests (${data.requests.length})`, `בקשות (${data.requests.length})`)}>
                  <ul className="flex flex-col gap-2">
                    {data.requests.map((r) => {
                      const l = LIFECYCLE[r.lifecycle] ?? LIFECYCLE.approved;
                      return (
                        <li key={r.id} className="flex items-center justify-between gap-3 text-[13.5px] text-o-ink-2">
                          <span className="min-w-0"><bdi>{r.what}</bdi></span>
                          <Chip tone={l.tone}>{l.label[lang]}</Chip>
                        </li>
                      );
                    })}
                  </ul>
                </Disclosure>
              )}
              <Disclosure summary={t(`Messages (${data.messages.length})`, `הודעות (${data.messages.length})`)} testId="messages">
                <ol className="flex flex-col gap-2">
                  {data.messages.map((m, i) => (
                    <li key={i} className={`flex flex-col ${m.from === "customer" ? "items-start" : "items-end"}`}>
                      <p dir="auto" className={`max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[14px] leading-6 ${m.from === "customer" ? "rounded-ss-md bg-o-sunken text-o-ink" : "rounded-se-md bg-o-accent/15 text-o-ink"}`}>{m.text}</p>
                      <span className="mt-0.5 px-1 text-[11px] text-o-faint">{m.from === "customer" ? name : m.from === "barry" ? "BARRY" : t("System", "מערכת")} · {ago(lang, m.at)}{m.notSent === "dry_run" ? t(" · test mode — not sent", " · מצב בדיקה — לא נשלח") : m.notSent === "failed" ? t(" · not delivered", " · לא נמסר") : ""}</span>
                    </li>
                  ))}
                </ol>
              </Disclosure>
            </div>
            <p className="text-[12.5px] leading-5 text-o-faint">{t("Read-only here: BARRY talks to the customer; you decide what it may do.", "כאן רק לקריאה: BARRY מדבר עם הלקוח, ואתה מחליט מה מותר לו לעשות.")}</p>
          </>
        )}
        <Button kind="quiet" onClick={onClose}>{t("Close", "סגירה")}</Button>
      </div>
    </Sheet>
  );
}
