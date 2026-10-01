import type { ReactNode } from "react";
import Link from "next/link";

/**
 * BARRY DESIGN LANGUAGE V1 — the reusable primitives (server-safe: no hooks, no browser APIs).
 * Editorial hierarchy: one brief, then the few things that matter, then everything else behind
 * disclosure. Status is always a word with an icon, never colour alone. See docs/DESIGN_LANGUAGE_V1.md.
 */

// ── Status semantics ──────────────────────────────────────────────────────────────────────────────

/** The product's status vocabulary. Each has ONE meaning; they are never interchangeable. */
export type Status = "ok" | "attention" | "blocked" | "degraded" | "not_ready" | "simulator" | "unknown" | "info" | "neutral";

export const STATUS_WORDS: Record<Status, string> = {
  ok: "OK",
  attention: "Needs attention",
  blocked: "Blocked",
  degraded: "Degraded",
  not_ready: "Not ready",
  simulator: "Simulator",
  unknown: "Unknown",
  info: "Info",
  neutral: "",
};

const STATUS_STYLE: Record<Status, { cls: string; icon: string }> = {
  ok: { cls: "bg-[#ecfdf3] text-[#067647] ring-[#abefc6]", icon: "✓" },
  attention: { cls: "bg-[#fffaeb] text-[#b54708] ring-[#fedf89]", icon: "!" },
  blocked: { cls: "bg-[#fef3f2] text-[#b42318] ring-[#fecdca]", icon: "✕" },
  degraded: { cls: "bg-[#fdf2fa] text-[#9e165f] ring-[#fcceee]", icon: "~" },
  not_ready: { cls: "bg-[#f2f4f7] text-[#475467] ring-[#d0d5dd]", icon: "◦" },
  simulator: { cls: "bg-[#eff8ff] text-[#175cd3] ring-[#b2ddff]", icon: "▷" },
  unknown: { cls: "bg-[#f9fafb] text-[#667085] ring-[#e4e7ec] border-dashed", icon: "?" },
  info: { cls: "bg-[#eff8ff] text-[#175cd3] ring-[#b2ddff]", icon: "i" },
  neutral: { cls: "bg-[#f2f4f7] text-[#344054] ring-[#e4e7ec]", icon: "•" },
};

/** Word + icon status. `children` overrides the default word; the icon always stays. */
export function StatusPill({ status, children, size = "sm" }: { status: Status; children?: ReactNode; size?: "sm" | "md" }) {
  const s = STATUS_STYLE[status];
  return (
    <span data-status={status} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full ring-1 ring-inset font-semibold ${size === "md" ? "px-2.5 py-1 text-[12px]" : "px-2 py-0.5 text-[11px]"} ${s.cls}`}>
      <span aria-hidden className="text-[10px] font-bold">{s.icon}</span>
      {children ?? STATUS_WORDS[status]}
    </span>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────────────────────────────

export const surface = "rounded-2xl bg-white shadow-[0_1px_2px_rgba(16,24,40,0.06),0_0_0_1px_rgba(16,24,40,0.04)]";
export const button = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-[#d0d5dd] bg-white px-3.5 py-2 text-sm font-medium text-[#344054] hover:bg-[#f9fafb] disabled:opacity-50";
export const buttonPrimary = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-[#1d2939] px-4 py-2 text-sm font-semibold text-white hover:bg-[#101828] disabled:opacity-50";
export const buttonDanger = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-[#fda29b] bg-white px-3.5 py-2 text-sm font-medium text-[#b42318] hover:bg-[#fef3f2] disabled:opacity-50";
export const buttonQuiet = "inline-flex min-h-9 items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium text-[#475467] hover:bg-[#f2f4f7]";
export const input = "min-h-10 w-full rounded-lg border border-[#d0d5dd] bg-white px-3 text-sm text-[#101828] placeholder:text-[#98a2b3] focus:border-[#1d2939] focus:outline-none";

/** Page container: one reading width (narrow for briefs, wide for fleet rows). */
export function Page({ width = "regular", children }: { width?: "narrow" | "regular" | "wide"; children: ReactNode }) {
  const w = width === "narrow" ? "max-w-3xl" : width === "wide" ? "max-w-6xl" : "max-w-5xl";
  return <main className={`mx-auto w-full ${w} px-4 pb-28 pt-5 md:pb-12 md:pt-8`}>{children}</main>;
}

/**
 * The one brief at the top of a surface: eyebrow (where / who), the sentence that matters, a
 * supporting line and at most two actions. Never a KPI grid.
 */
export function HeroBrief({ eyebrow, title, lead, actions, aside }: { eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode; actions?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-4 md:mb-8 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0 max-w-2xl">
        {eyebrow && <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#667085]">{eyebrow}</p>}
        <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-tight text-[#101828] md:text-[34px]">{title}</h1>
        {lead && <p className="mt-2 text-[15px] leading-relaxed text-[#475467]">{lead}</p>}
        {actions && <div className="mt-4 flex flex-wrap gap-2">{actions}</div>}
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </header>
  );
}

export function Section({ title, subtitle, right, children, plain, id, tight }: { title?: ReactNode; subtitle?: ReactNode; right?: ReactNode; children: ReactNode; plain?: boolean; id?: string; tight?: boolean }) {
  return (
    <section id={id} className={plain ? "" : `${surface} ${tight ? "p-4" : "p-4 md:p-5"}`}>
      {(title || right) && (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-[#101828] md:text-base">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] text-[#667085]">{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

/** Progressive disclosure: closed by default, one line of summary, details on demand. */
export function Disclosure({ summary, children, open, muted }: { summary: ReactNode; children: ReactNode; open?: boolean; muted?: boolean }) {
  return (
    <details className="group" open={open}>
      <summary className={`flex cursor-pointer list-none items-center gap-2 rounded-lg py-1.5 text-[13px] font-medium ${muted ? "text-[#667085]" : "text-[#344054]"} hover:text-[#101828] [&::-webkit-details-marker]:hidden`}>
        <span aria-hidden className="inline-block w-3 text-[10px] text-[#98a2b3] transition-transform group-open:rotate-90">▶</span>
        {summary}
      </summary>
      <div className="mt-1 pb-1 pl-5">{children}</div>
    </details>
  );
}

/** A number or amount in a sentence: label · value — never a tile. */
export function MetricInline({ label, value, status }: { label: string; value: ReactNode; status?: Status }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 text-[13px] text-[#475467]">
      <span>{label}</span>
      <span className={`font-semibold tabular-nums ${status === "blocked" ? "text-[#b42318]" : status === "ok" ? "text-[#067647]" : "text-[#101828]"}`}>{value}</span>
    </span>
  );
}

/** A list of inline metrics separated by quiet dots. */
export function MetricLine({ items }: { items: { label: string; value: ReactNode; status?: Status }[] }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((m, i) => (
        <MetricInline key={i} {...m} />
      ))}
    </p>
  );
}

/**
 * One thing that needs a person (or that BARRY is on). Title first, why second, the move third.
 * Full-width tap target on phones; actions wrap under the text.
 */
export function FocusItem({ status, title, why, move, meta, href, actions, rank }: { status?: Status; title: ReactNode; why?: ReactNode; move?: ReactNode; meta?: ReactNode; href?: string; actions?: ReactNode; rank?: number }) {
  const body = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {rank !== undefined && <span className="text-[12px] font-semibold tabular-nums text-[#98a2b3]">{rank}</span>}
          {status && <StatusPill status={status} />}
          <span className="text-[15px] font-semibold leading-snug text-[#101828]">{title}</span>
        </div>
        {why && <p className="text-[13px] leading-relaxed text-[#475467]">{why}</p>}
        {move && <p className="text-[13px] font-medium text-[#101828]">{move}</p>}
        {meta && <p className="text-[12px] text-[#98a2b3]">{meta}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">{actions}</div>}
    </>
  );
  const cls = "flex flex-col gap-3 py-3.5 sm:flex-row sm:items-start first:pt-0 last:pb-0";
  return href && !actions ? (
    <Link href={href} className={`${cls} -mx-2 rounded-xl px-2 hover:bg-[#f9fafb]`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function FocusList({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-[#f2f4f7]">{children}</div>;
}

/** One line of what happened: when · what · for whom · by whom · verified? · still needed? */
export function ActivityRow({ when, what, who, by, verified, stillNeeded, href, status, statusWord }: { when: ReactNode; what: ReactNode; who?: ReactNode; by?: ReactNode; verified?: "verified" | "unverified" | "n/a"; stillNeeded?: ReactNode; href?: string; status?: Status; statusWord?: string }) {
  const inner = (
    <>
      <span className="w-full shrink-0 text-[12px] tabular-nums text-[#98a2b3] sm:w-28">{when}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5 text-[14px] text-[#101828]">
          {status && <StatusPill status={status}>{statusWord}</StatusPill>}
          <span>{what}</span>
        </span>
        <span className="text-[12px] text-[#667085]">
          {who && <span>for {who}</span>}
          {by && <span>{who ? " · " : ""}by {by}</span>}
          {verified === "verified" && <span> · verified</span>}
          {verified === "unverified" && <span className="text-[#b54708]"> · not verified</span>}
          {stillNeeded && <span className="text-[#101828]"> · still needed: {stillNeeded}</span>}
        </span>
      </span>
    </>
  );
  const cls = "flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:gap-3 first:pt-0 last:pb-0";
  return href ? (
    <Link href={href} className={`${cls} -mx-2 rounded-lg px-2 hover:bg-[#f9fafb]`}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

export function Timeline({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-[#f2f4f7]">{children}</div>;
}

/** An intentional empty state: what this space shows once something happens. Calm, never celebratory. */
export function EmptyState({ title, children, action }: { title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl bg-[#f9fafb] px-4 py-6 text-center">
      {title && <p className="text-sm font-semibold text-[#101828]">{title}</p>}
      {children && <p className={`text-sm text-[#667085] ${title ? "mt-1" : ""}`}>{children}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

/** Loading, error and blocked states share one quiet notice. */
export function Notice({ status, title, children, action }: { status: Status; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const bg = status === "blocked" ? "border-[#fecdca] bg-[#fef3f2]" : status === "attention" || status === "degraded" ? "border-[#fedf89] bg-[#fffaeb]" : status === "ok" ? "border-[#abefc6] bg-[#f6fef9]" : "border-[#e4e7ec] bg-white";
  return (
    <div className={`rounded-2xl border px-4 py-4 ${bg}`} role="status">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-[#101828]">
            <StatusPill status={status} />
            {title}
          </p>
          {children && <div className="mt-1 text-sm text-[#475467]">{children}</div>}
        </div>
        {action}
      </div>
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="animate-pulse space-y-2" aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-3.5 rounded bg-[#eaecf0]" style={{ width: `${88 - i * 14}%` }} />
      ))}
    </div>
  );
}

/** Actions at the end of a surface, full-width on phones. */
export function ActionBar({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-[#f2f4f7] pt-4 sm:flex-row sm:items-center sm:justify-between">
      {note ? <p className="text-[12px] text-[#667085]">{note}</p> : <span />}
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end [&>*]:w-full sm:[&>*]:w-auto">{children}</div>
    </div>
  );
}

/**
 * CONSEQUENTIAL ACTION — scope, effect, reversibility and audit stated before the button; a reason and
 * an explicit confirmation are required (the API refuses without both). Server-form based.
 */
export function Confirmation({ action, hidden, title, scope, effect, reversibility, audit, submit, danger, reasonPlaceholder, children }: { action: string; hidden: Record<string, string>; title: ReactNode; scope: ReactNode; effect: ReactNode; reversibility: ReactNode; audit?: ReactNode; submit: string; danger?: boolean; reasonPlaceholder?: string; children?: ReactNode }) {
  return (
    <form action={action} method="post" className="flex flex-col gap-3 rounded-xl bg-[#f9fafb] p-4">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <p className="text-[14px] font-semibold text-[#101828]">{title}</p>
      <dl className="grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[7rem_1fr]">
        <dt className="text-[#667085]">Scope</dt>
        <dd className="text-[#344054]">{scope}</dd>
        <dt className="text-[#667085]">Effect</dt>
        <dd className="text-[#344054]">{effect}</dd>
        <dt className="text-[#667085]">Reversible</dt>
        <dd className="text-[#344054]">{reversibility}</dd>
        <dt className="text-[#667085]">Audit</dt>
        <dd className="text-[#344054]">{audit ?? "Recorded with who, when, why and before → after. Nothing is recorded when the state does not change."}</dd>
      </dl>
      {children}
      <label className="text-[12px] text-[#667085]">
        Reason (required, audited)
        <input name="reason" required minLength={3} maxLength={500} placeholder={reasonPlaceholder ?? "Why now"} className={`${input} mt-1`} />
      </label>
      <label className="flex items-start gap-2 text-[13px] text-[#344054]">
        <input type="checkbox" name="confirm" value="yes" required className="mt-1" /> I understand the scope and effect above.
      </label>
      <div>
        <button className={`${danger ? buttonDanger : buttonPrimary} w-full sm:w-auto`}>{submit}</button>
      </div>
    </form>
  );
}

/** A raw technical value (ids, ISO instants) — only inside technical / trace views. */
export function Technical({ children }: { children: ReactNode }) {
  return <code className="break-all rounded bg-[#f2f4f7] px-1 py-0.5 font-mono text-[11px] text-[#475467]">{children}</code>;
}

/** Quiet key → value rows (for technical / details surfaces, never for the brief). */
export function Kv({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5 text-[13px] sm:flex-row sm:justify-between sm:gap-3">
      <span className="shrink-0 text-[#667085]">{k}</span>
      <span className="min-w-0 break-words text-[#101828] sm:text-right">{v}</span>
    </div>
  );
}
