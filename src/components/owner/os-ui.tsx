"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./kit";
import { useOwnerLang } from "./lang";

/**
 * OWNER OS PRIMITIVES (Pass 1) — the small grammar every Owner OS surface is built from. Founder HQ will
 * inherit it in Pass 2 (see docs/OWNER_OS_DESIGN.md).
 *
 *   PageHeader      title + one line, optional back to More, optional trailing control
 *   SectionLabel    a quiet uppercase label above a group, with an optional "All ›" action
 *   Group + Row     the default container: one rounded group of tappable rows (≥ 56px), hairlines between
 *   Chip / Dot      state, always as a word (colour is never the only signal)
 *   Sheet           detail: bottom sheet on phones, side panel on desktop — summary → detail → evidence
 *   Disclosure      evidence / provenance one tap away, never in the way
 *   ConfirmButton   consequential actions take two deliberate taps, with the consequence in the button
 *   Empty / Loading / ErrorState   intentional states, no developer dumps
 *
 * Direction: everything uses logical properties (start / end), chevrons mirror in RTL, and owner or
 * customer text is isolated (<bdi> / dir="auto") so mixed Hebrew and English never reorders.
 */

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral" | "violet";

const CHIP: Record<Tone, string> = {
  ok: "bg-o-ok-bg text-o-ok ring-o-ok-line",
  warn: "bg-o-warn-bg text-o-warn ring-o-warn-line",
  bad: "bg-o-bad-bg text-o-bad ring-o-bad-line",
  info: "bg-o-info-bg text-o-info ring-o-info-line",
  neutral: "bg-o-neutral-bg text-o-muted ring-o-neutral-line",
  violet: "bg-o-violet/10 text-o-violet ring-o-violet/30",
};
const DOT: Record<Tone, string> = { ok: "bg-o-ok", warn: "bg-o-warn", bad: "bg-o-bad", info: "bg-o-accent", neutral: "bg-o-faint", violet: "bg-o-violet" };
export const TONE_TEXT: Record<Tone, string> = { ok: "text-o-ok", warn: "text-o-warn", bad: "text-o-bad", info: "text-o-info", neutral: "text-o-muted", violet: "text-o-violet" };

export function Chip({ tone = "neutral", children, testId }: { tone?: Tone; children: ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className={`inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium leading-5 ring-1 ring-inset ${CHIP[tone]}`}>
      {children}
    </span>
  );
}

export function Dot({ tone = "neutral", pulse }: { tone?: Tone; pulse?: boolean }) {
  return <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[tone]} ${pulse ? "o-live-dot" : ""}`} />;
}

/** A forward chevron that points the reading direction (mirrors in RTL). */
export const Chevron = ({ className = "" }: { className?: string }) => <Icon name="chevron" size={16} className={`shrink-0 text-o-faint rtl:-scale-x-100 ${className}`} />;

export function PageHeader({ title, sub, back, right }: { title: ReactNode; sub?: ReactNode; back?: { href: string; label: string }; right?: ReactNode }) {
  return (
    <header className="flex flex-col gap-1 pt-1">
      {back && (
        <Link href={back.href} className="-ms-1 mb-1 inline-flex min-h-11 w-fit items-center gap-1 rounded-lg px-1 text-[13.5px] font-medium text-o-accent lg:hidden">
          <Icon name="chevron" size={16} className="rotate-180 rtl:rotate-0" />
          {back.label}
        </Link>
      )}
      <div className="flex items-start justify-between gap-3">
        <h1 className="min-w-0 text-[26px] font-semibold leading-tight tracking-[-0.02em] text-o-ink md:text-[30px]">{title}</h1>
        {right && <div className="shrink-0 pt-1">{right}</div>}
      </div>
      {sub && <p className="text-[14.5px] leading-snug text-o-muted">{sub}</p>}
    </header>
  );
}

export function SectionLabel({ children, action, id }: { children: ReactNode; action?: { label: string; href?: string; onClick?: () => void }; id?: string }) {
  const cls = "inline-flex min-h-11 items-center gap-0.5 text-[13px] font-medium text-o-accent";
  return (
    <div id={id} className="flex scroll-mt-24 items-center justify-between gap-2 px-1">
      <h2 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-o-muted">{children}</h2>
      {action && (action.href ? <Link href={action.href} className={cls}>{action.label}<Chevron className="text-o-accent" /></Link> : <button type="button" onClick={action.onClick} className={cls}>{action.label}<Chevron className="text-o-accent" /></button>)}
    </div>
  );
}

export function Group({ children, className = "", label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div role="list" aria-label={label} className={`o-group ${className}`}>
      {children}
    </div>
  );
}

/**
 * One row: what it is (title), one line of why/where (sub), and the state or figure that matters at the
 * end. Tapping opens the detail. Owner / customer text is bidi-isolated.
 */
export function Row({ lead, title, sub, end, endSub, chip, href, onClick, chevron = true, testId, emphasis, id }: { lead?: ReactNode; title: ReactNode; sub?: ReactNode; end?: ReactNode; endSub?: ReactNode; chip?: ReactNode; href?: string; onClick?: () => void; chevron?: boolean; testId?: string; emphasis?: boolean; id?: string }) {
  const body = (
    <>
      {lead && <span className="flex w-9 shrink-0 items-center justify-center">{lead}</span>}
      <span className="min-w-0 flex-1">
        <span className={`block text-[15px] leading-5 ${emphasis ? "font-semibold text-o-ink" : "font-medium text-o-ink"}`}>
          <bdi>{title}</bdi>
        </span>
        {sub && <span className="mt-0.5 block truncate text-[13px] leading-5 text-o-muted">{sub}</span>}
      </span>
      {(end || endSub || chip) && (
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-end">
          {end && <span className="o-tabular text-[15px] font-semibold text-o-ink">{end}</span>}
          {chip}
          {endSub && <span className="text-[12px] text-o-faint">{endSub}</span>}
        </span>
      )}
      {(href || onClick) && chevron && <Chevron />}
    </>
  );
  const cls = "flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-start transition active:bg-o-sunken/80 hover:bg-o-sunken/40";
  if (href) return <Link role="listitem" href={href} className={cls} data-testid={testId} id={id}>{body}</Link>;
  if (onClick) return <button role="listitem" type="button" onClick={onClick} className={cls} data-testid={testId} id={id}>{body}</button>;
  return <div role="listitem" className={cls} data-testid={testId} id={id}>{body}</div>;
}

/** A round icon tile for row leads. */
export function Lead({ icon, tone = "neutral" }: { icon: IconName; tone?: Tone }) {
  return (
    <span className={`inline-flex h-9 w-9 items-center justify-center rounded-xl ring-1 ring-inset ${CHIP[tone]}`}>
      <Icon name={icon} size={17} />
    </span>
  );
}

export function Disclosure({ summary, children, defaultOpen, testId }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; testId?: string }) {
  return (
    <details open={defaultOpen} className="group" data-testid={testId}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-[13.5px] font-medium text-o-ink-2 [&::-webkit-details-marker]:hidden">
        {summary}
        <Icon name="chevron" size={15} className="shrink-0 rotate-90 text-o-faint transition group-open:-rotate-90" />
      </summary>
      <div className="pb-1 pt-1">{children}</div>
    </details>
  );
}

/** A field in a detail sheet: label above, value below. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[12px] font-medium text-o-faint">{label}</dt>
      <dd className="text-[14.5px] leading-6 text-o-ink-2">{children}</dd>
    </div>
  );
}

/**
 * THE DETAIL SHEET — summary → detail → evidence. Bottom sheet on phones (thumb reach, keeps context
 * behind it), side panel on desktop. Escape / scrim / close button dismiss; the page behind doesn't scroll.
 */
export function Sheet({ open, onClose, title, children, footer, testId }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; testId?: string }) {
  const { t } = useOwnerLang();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end lg:items-stretch lg:justify-end" data-testid={testId}>
      <div className="o-scrim absolute inset-0" onClick={onClose} role="presentation" />
      <div role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} className="o-sheet o-sheet-in relative flex max-h-[90dvh] w-full flex-col rounded-t-[22px] lg:h-full lg:max-h-none lg:w-[460px] lg:rounded-none lg:border-s lg:border-o-line">
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-o-line-strong lg:hidden" />
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-2 pt-3">
          <h2 className="min-w-0 text-[18px] font-semibold leading-snug text-o-ink">{title}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("Close", "סגירה")} className="-me-2 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-o-muted hover:bg-o-sunken hover:text-o-ink">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">{children}</div>
        {footer && <div className="shrink-0 border-t border-o-line px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">{footer}</div>}
      </div>
    </div>
  );
}

const BTN = {
  primary: "bg-o-accent text-white hover:brightness-110",
  secondary: "bg-o-raised text-o-ink ring-1 ring-inset ring-o-line-strong hover:ring-o-accent/50",
  danger: "bg-o-bad-bg text-o-bad ring-1 ring-inset ring-o-bad-line",
  quiet: "text-o-ink-2 hover:bg-o-sunken",
} as const;
export const buttonClass = (kind: keyof typeof BTN = "secondary", full = false) => `inline-flex min-h-12 items-center justify-center gap-1.5 rounded-xl px-4 text-[15px] font-semibold transition disabled:opacity-50 ${BTN[kind]} ${full ? "w-full" : ""}`;

export function Button({ kind = "secondary", full, children, onClick, disabled, href, testId, type = "button" }: { kind?: keyof typeof BTN; full?: boolean; children: ReactNode; onClick?: () => void; disabled?: boolean; href?: string; testId?: string; type?: "button" | "submit" }) {
  if (href) return <Link href={href} className={buttonClass(kind, full)} data-testid={testId}>{children}</Link>;
  return <button type={type} className={buttonClass(kind, full)} onClick={onClick} disabled={disabled} data-testid={testId}>{children}</button>;
}

/**
 * A consequential action: the first tap arms it (and says exactly what will happen), the second does it.
 * Nothing consequential is one accidental tap away.
 */
export function ConfirmButton({ label, confirmLabel, consequence, onConfirm, kind = "primary", disabled, testId }: { label: string; confirmLabel: string; consequence?: string; onConfirm: () => void | Promise<void>; kind?: keyof typeof BTN; disabled?: boolean; testId?: string }) {
  const { t } = useOwnerLang();
  const [armed, setArmed] = useState(false);
  if (!armed) return <Button kind={kind} full onClick={() => setArmed(true)} disabled={disabled} testId={testId}>{label}</Button>;
  return (
    <div className="flex flex-col gap-2" data-testid={testId ? `${testId}-confirm` : undefined}>
      {consequence && <p className="text-[13px] leading-5 text-o-muted">{consequence}</p>}
      <div className="flex gap-2">
        <Button kind="quiet" onClick={() => setArmed(false)}>{t("Cancel", "ביטול")}</Button>
        <div className="flex-1">
          <Button kind={kind} full disabled={disabled} onClick={() => void onConfirm()} testId={testId ? `${testId}-go` : undefined}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="o-card">
      <div className="flex flex-col items-start gap-1.5 px-4 py-5">
        <p className="text-[15px] font-medium text-o-ink">{title}</p>
        {children && <p className="text-[13.5px] leading-6 text-o-muted">{children}</p>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="o-group" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex min-h-[56px] items-center gap-3 px-4">
          <span className="o-shimmer h-8 w-8 rounded-lg" />
          <span className="flex-1 space-y-1.5">
            <span className="o-shimmer block h-3 w-2/3 rounded" />
            <span className="o-shimmer block h-2.5 w-1/3 rounded" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ title, onRetry, detail }: { title: string; onRetry?: () => void; detail?: string }) {
  const { t } = useOwnerLang();
  return (
    <div role="alert" className="o-card">
      <div className="flex flex-col gap-2 px-4 py-4">
      <p className="flex items-center gap-2 text-[15px] font-medium text-o-ink"><Dot tone="bad" />{title}</p>
      <p className="text-[13.5px] text-o-muted">{t("Nothing changed in your business — this page couldn't read its records.", "שום דבר לא השתנה בעסק — הדף לא הצליח לקרוא את הרשומות.")}</p>
      {detail && (
        <Disclosure summary={<span className="text-[12px] text-o-faint">{t("Technical detail", "פרט טכני")}</span>}>
          <p className="break-words text-[12px] text-o-faint" dir="ltr">{detail}</p>
        </Disclosure>
      )}
      {onRetry && <div><Button onClick={onRetry}>{t("Try again", "לנסות שוב")}</Button></div>}
      </div>
    </div>
  );
}

/** A notice line (not a card): one tone dot, one sentence, optional action. */
export function Notice({ tone, children, action }: { tone: Tone; children: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === "bad" ? "alert" : "status"} className="flex items-start gap-2.5 rounded-xl bg-o-sunken/70 px-3.5 py-3 text-[13.5px] leading-5 text-o-ink-2 ring-1 ring-inset ring-o-line">
      <span className="pt-1.5"><Dot tone={tone} /></span>
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

/** An equal-width segmented control (2–4 choices) — thumb-sized, with counts. */
export function Segments<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: { id: T; label: string; count?: number }[]; onChange: (v: T) => void; ariaLabel: string }) {
  // Four choices don't fit a label and a count side by side on a phone: the count goes under the label.
  const stack = options.length >= 4 && options.some((o) => o.count);
  return (
    <div role="tablist" aria-label={ariaLabel} className="grid gap-1 rounded-xl bg-o-sunken p-1 ring-1 ring-inset ring-o-line" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={value === o.id} onClick={() => onChange(o.id)} className={`flex min-h-10 min-w-0 items-center justify-center rounded-lg px-1.5 text-[13.5px] font-medium transition ${stack ? "flex-col gap-0 py-1 leading-tight" : "gap-1.5"} ${value === o.id ? "bg-o-raised text-o-ink ring-1 ring-inset ring-o-line-strong" : "text-o-muted hover:text-o-ink"}`} data-testid={`seg-${o.id}`}>
          <span className="truncate">{o.label}</span>
          {o.count ? <span className={`o-tabular rounded-full px-1.5 text-[11px] ${value === o.id ? "bg-o-accent/20 text-o-ink" : "bg-o-raised text-o-muted"}`}>{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
