"use client";

import { useState } from "react";
import type { Intervention } from "@/lib/owner/interventions";
import { ago } from "@/lib/owner/lang";
import { Icon } from "../kit";
import { useOwnerLang } from "../lang";
import { Button, Chip, ConfirmButton, Disclosure, Field, Row, Sheet } from "../os-ui";
import { INTERVENTION_KIND, initial, type Act } from "./shared";

/**
 * NEEDS YOU — a decision, not an audit record. The row says WHAT (customer · one line), the STATE, and
 * the figure; the sheet carries the exact context: why it's with you, exactly what you decide, what each
 * option causes, what BARRY already did, and how current it is. Approve and decline take two deliberate
 * taps with the consequence spelled out; the owner endpoints still re-check everything before any effect.
 */

export function DecisionRow({ item, onOpen }: { item: Intervention; onOpen: () => void }) {
  const { lang } = useOwnerLang();
  const k = INTERVENTION_KIND[item.kind];
  return (
    <Row
      testId="decision-row"
      lead={<span className={`inline-flex h-9 w-9 items-center justify-center rounded-full bg-o-raised text-[14px] font-semibold text-o-ink-2 ring-1 ring-inset ring-o-line`}>{initial(item.customer)}</span>}
      title={item.customer}
      sub={item.title}
      end={item.amount ? <bdi>{item.amount}</bdi> : undefined}
      chip={<Chip tone={k.tone}>{k.label[lang]}</Chip>}
      onClick={onOpen}
    />
  );
}

export function DecisionSheet({ item, onClose, act, busy, onConversation }: { item: Intervention | null; onClose: () => void; act: Act; busy: boolean; onConversation: (conversationId: string) => void }) {
  const { lang, t } = useOwnerLang();
  const [done, setDone] = useState(false);
  if (!item) return null;
  const k = INTERVENTION_KIND[item.kind];
  const run = async (action: Parameters<Act>[1]) => {
    setDone(true);
    try {
      await act(item, action);
    } finally {
      setDone(false);
      onClose();
    }
  };
  const approve = item.options.find((o) => o.action === "approve");
  const decline = item.options.find((o) => o.action === "decline");
  const others = item.options.filter((o) => o.action !== "approve" && o.action !== "decline");
  return (
    <Sheet
      open
      onClose={onClose}
      testId="decision-sheet"
      title={<bdi>{item.title}</bdi>}
      footer={
        <div className="flex flex-col gap-2">
          {approve && <ConfirmButton testId="approve" label={approve.label} confirmLabel={t("Yes, approve", "כן, לאשר")} consequence={approve.consequence} onConfirm={() => run("approve")} disabled={busy || done} />}
          {others.map((o) =>
            o.action === "open_conversation" ? (
              <Button key={o.action} kind={approve ? "secondary" : "primary"} full onClick={() => onConversation(item.conversationId)}>{o.label}</Button>
            ) : (
              <Button key={o.action} kind={o.primary && !approve ? "primary" : "secondary"} full disabled={busy || done} onClick={() => void run(o.action)} testId={`act-${o.action}`}>{o.label}</Button>
            ),
          )}
          {decline && <ConfirmButton testId="decline" kind="danger" label={decline.label} confirmLabel={t("Yes, decline", "כן, לדחות")} consequence={decline.consequence} onConfirm={() => run("decline")} disabled={busy || done} />}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-o-muted">
          <Chip tone={k.tone}>{k.label[lang]}</Chip>
          <span><bdi>{item.customer}</bdi> · {ago(lang, item.since)}</span>
        </p>
        {item.amount && <p className="o-tabular text-[30px] font-semibold tracking-tight text-o-ink"><bdi>{item.amount}</bdi></p>}
        <dl className="flex flex-col gap-3">
          <Field label={t("Why it's with you", "למה זה אצלך")}>{item.why}</Field>
          <Field label={t("What you decide", "מה אתה מחליט")}>{item.decision}</Field>
          <Field label={t("What happens next", "מה קורה אחר כך")}>{item.then}</Field>
        </dl>
        <div className="divide-y divide-o-line border-y border-o-line">
          {item.tried.length > 0 && (
            <Disclosure summary={t("What BARRY already did", "מה BARRY כבר עשה")}>
              <ol className="flex flex-col gap-1.5 text-[13.5px] text-o-ink-2">
                {item.tried.map((x, i) => (
                  <li key={i} className="flex gap-2"><Icon name="check" size={14} className="mt-1 shrink-0 text-o-faint" /><span><bdi>{x}</bdi></span></li>
                ))}
              </ol>
            </Disclosure>
          )}
          <Disclosure summary={t("How current this is · records", "כמה זה עדכני · רשומות")}>
            <p className="text-[13.5px] text-o-ink-2">{item.freshness}</p>
            <ul className="mt-2 flex flex-col gap-1 text-[12px] text-o-faint" dir="ltr">
              {item.evidence.map((e) => <li key={e} className="break-all">{e}</li>)}
            </ul>
          </Disclosure>
        </div>
        {!others.some((o) => o.action === "open_conversation") && <Button kind="quiet" onClick={() => onConversation(item.conversationId)}>{t("Open the conversation", "לפתוח את השיחה")}</Button>}
      </div>
    </Sheet>
  );
}
