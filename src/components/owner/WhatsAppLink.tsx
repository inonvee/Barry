"use client";

import { useCallback, useEffect, useState } from "react";
import type { useOwnerApi } from "./useOwnerApi";
import { useOwnerLang } from "./lang";
import { Button, Chip, Group, Lead, Notice, Row } from "./os-ui";
import { ago } from "@/lib/owner/lang";

type Api = ReturnType<typeof useOwnerApi>;
type LinkRow = { id: string; number: string; status: "active" | "revoked" | "inactive"; linkedAt: string; lastMessageAt: string | null };
type State = { line: { configured: boolean; sendMode: "live" | "dry_run"; display: string | null }; links: LinkRow[] };

/**
 * YOUR WHATSAPP — link the owner's own number to this business. The owner (signed in here) gets a
 * one-time code and sends it FROM their WhatsApp to BARRY (its owner line, or the shared BARRY number); that proves the number is
 * theirs. One business per link; revoking (or a change of owner access) stops it immediately.
 */
export function WhatsAppLink({ api }: { api: Api }) {
  const { lang, t } = useOwnerLang();
  const { businessId, call } = api;
  const [state, setState] = useState<State | null>(null);
  const [code, setCode] = useState<{ send: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => call<State>(`/api/owner/whatsapp?businessId=${encodeURIComponent(businessId)}`).then(setState).catch((e: Error) => setError(e.message)), [businessId, call]);
  useEffect(() => {
    if (businessId) void load();
  }, [businessId, load]);
  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      const r = await call<{ send?: string; expiresAt?: string }>("/api/owner/whatsapp", { body: { businessId, ...body } });
      if (r.send && r.expiresAt) setCode({ send: r.send, expiresAt: r.expiresAt });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  };
  if (!state) return null;
  if (!state.line.configured) return <Notice tone="neutral">{t("BARRY's owner WhatsApp line isn't set up yet — the BARRY team turns it on. Until then, use Ask; it's the same BARRY.", "קו הוואטסאפ של BARRY לבעלים עוד לא הוגדר — צוות BARRY מפעיל אותו. עד אז אפשר להשתמש ב״שאל״ — זה אותו BARRY.")}</Notice>;
  const links = state.links.filter((l) => l.status !== "revoked");
  const active = links.filter((l) => l.status === "active");
  return (
    <div className="flex flex-col gap-3">
      {state.line.sendMode === "dry_run" && <Notice tone="warn">{t("Test mode: BARRY records its WhatsApp replies to you but doesn't send them yet.", "מצב בדיקה: BARRY רושם את התשובות אליך בוואטסאפ אבל עוד לא שולח אותן.")}</Notice>}
      {links.length > 0 && (
        <Group>
          {links.map((l) => (
            <Row
              key={l.id}
              lead={<Lead icon="phone" tone={l.status === "active" ? "ok" : "neutral"} />}
              title={<span dir="ltr">{l.number}</span>}
              sub={l.status === "active" ? (l.lastMessageAt ? t(`Last message ${ago(lang, l.lastMessageAt)}`, `הודעה אחרונה ${ago(lang, l.lastMessageAt)}`) : t("Linked", "מקושר")) : t("Inactive — owner access changed; link again", "לא פעיל — גישת הבעלים השתנתה; צריך לקשר שוב")}
              chip={<Chip tone={l.status === "active" ? "ok" : "neutral"}>{l.status === "active" ? t("Linked", "מקושר") : t("Inactive", "לא פעיל")}</Chip>}
              end={<button type="button" className="text-[13px] font-medium text-o-bad" disabled={busy} onClick={() => void act({ action: "revoke", id: l.id })}>{t("Unlink", "ניתוק")}</button>}
            />
          ))}
        </Group>
      )}
      {code ? (
        <div className="o-card flex flex-col gap-2 px-4 py-4">
          <p className="text-[13.5px] text-o-muted">{t("From your WhatsApp, send this to BARRY within 15 minutes:", "מהוואטסאפ שלך, שלח את זה ל־BARRY תוך 15 דקות:")}{state.line.display ? <bdi dir="ltr"> +{state.line.display}</bdi> : null}</p>
          <p className="select-all font-mono text-[22px] font-semibold tracking-wider text-o-ink" dir="ltr">{code.send}</p>
          {state.line.display && <Button kind="primary" full href={`https://wa.me/${state.line.display}?text=${encodeURIComponent(code.send)}`}>{t("Open WhatsApp", "לפתוח את וואטסאפ")}</Button>}
        </div>
      ) : (
        <Button kind={active.length ? "secondary" : "primary"} full disabled={busy} onClick={() => void act({ action: "code" })} testId="whatsapp-link">{active.length ? t("Link another number", "לקשר מספר נוסף") : t("Link my WhatsApp", "לקשר את הוואטסאפ שלי")}</Button>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}
