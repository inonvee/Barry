import type { ReactNode } from "react";
import type { Sourced } from "@/lib/hq/service";

export function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-2xl bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_0_0_1px_rgba(16,24,40,0.04)] md:p-5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-[#101828]">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

const TONES = {
  good: "bg-[#ecfdf3] text-[#067647] ring-[#abefc6]",
  warn: "bg-[#fffaeb] text-[#b54708] ring-[#fedf89]",
  bad: "bg-[#fef3f2] text-[#b42318] ring-[#fecdca]",
  info: "bg-[#eff8ff] text-[#175cd3] ring-[#b2ddff]",
  neutral: "bg-[#f2f4f7] text-[#344054] ring-[#e4e7ec]",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${TONES[tone]}`}>{children}</span>;
}

export function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-1 text-[13px] sm:flex-row sm:justify-between sm:gap-3">
      <span className="shrink-0 text-[#667085]">{k}</span>
      <span className="min-w-0 break-words font-medium text-[#101828] sm:text-right">{v}</span>
    </div>
  );
}

export function Unavailable({ reason }: { reason: string }) {
  return <span className="text-sm italic text-[#667085]">{reason}</span>;
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
