import type { ReactNode } from "react";
import Link from "next/link";
import type { Sourced } from "@/lib/hq/service";

export function HqHeader({ crumbs }: { crumbs: { href?: string; label: string }[] }) {
  return (
    <header className="sticky top-0 z-10 border-b border-neutral-200 dark:border-neutral-800 bg-white/90 dark:bg-neutral-950/90 backdrop-blur">
      <div className="mx-auto max-w-6xl px-4 py-3 flex items-center gap-3">
        <nav className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
          <Link href="/hq" className="font-semibold shrink-0">
            BARRY HQ
          </Link>
          {crumbs.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1.5">
              <span className="text-neutral-400">/</span>
              {c.href ? (
                <Link href={c.href} className="truncate hover:underline">
                  {c.label}
                </Link>
              ) : (
                <span className="truncate text-neutral-500">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
        <nav className="hidden md:flex items-center gap-3 text-xs text-neutral-500">
          <Link href="/simulator" className="hover:underline">Simulator</Link>
          <Link href="/owner" className="hover:underline">Owner</Link>
          <Link href="/owner/train" className="hover:underline">Train</Link>
          <Link href="/qa" className="hover:underline">QA</Link>
          <Link href="/hq/ask" className="hover:underline">Ask HQ</Link>
        </nav>
        <span className="hidden sm:inline text-xs rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-neutral-600 dark:text-neutral-300">founder</span>
        <form action="/api/hq/logout" method="post">
          <button className="text-xs text-neutral-500 hover:underline">Sign out</button>
        </form>
      </div>
    </header>
  );
}

export function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

const TONES = {
  good: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  bad: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  info: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  neutral: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

export function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-0.5 text-sm">
      <span className="shrink-0 text-neutral-500">{k}</span>
      <span className="min-w-0 break-words text-right font-medium">{v}</span>
    </div>
  );
}

export function Unavailable({ reason }: { reason: string }) {
  return <span className="text-sm italic text-neutral-500">{reason}</span>;
}

/** Renders a sourced value, or says it is unavailable — never a fabricated zero. */
export function WithSource<T>({ value, children }: { value: Sourced<T>; children: (v: T) => ReactNode }) {
  return value.ok ? <>{children(value.value)}</> : <Unavailable reason={value.unavailable} />;
}

/** A count that may be unknown (its source failed). */
export function n(value: number | null): string {
  return value === null ? "unavailable" : String(value);
}

export function statusTone(status: string): Tone {
  if (["ready", "operational", "connected", "live_proven", "verified", "real", "paid", "approved", "created", "confirmed"].includes(status)) return "good";
  if (["simulated", "mixed"].includes(status)) return "info";
  if (["blocked", "error", "failed", "declined", "rejected", "not_built"].includes(status)) return "bad";
  if (["pending", "candidate", "needs_review", "needs_client_provider", "detected_not_connected", "not_connected", "partial"].includes(status)) return "warn";
  return "neutral";
}

export function label(status: string): string {
  return status.replace(/_/g, " ");
}
