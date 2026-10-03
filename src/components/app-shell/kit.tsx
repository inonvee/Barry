"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRightIcon, UserRoundIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * BARRY KIT — the 20% of identity on top of shadcn. Every visual here stands for real state:
 *   tone      live (BARRY working / verified) · info (waiting / selected) · hot (needs the owner) · warn (at risk) · plum
 *   Status    a pill with a dot, one tone, one word
 *   Thumb     a real image when one exists, else initials (people) or an icon tile (things) — never a stock picture
 *   Spark/Bars/Progress   drawn only from real series and counts
 *   Count     a number that settles in once when it changes on a re-read (never on first paint)
 */

export type Tone = "live" | "info" | "hot" | "warn" | "plum" | "muted";

const TEXT: Record<Tone, string> = { live: "text-live", info: "text-info", hot: "text-hot", warn: "text-warn", plum: "text-plum", muted: "text-muted-foreground" };
const BG: Record<Tone, string> = { live: "bg-live", info: "bg-info", hot: "bg-hot", warn: "bg-warn", plum: "bg-plum", muted: "bg-muted-foreground" };
const SOFT: Record<Tone, string> = { live: "bg-live/12 text-live", info: "bg-info/12 text-info", hot: "bg-hot/12 text-hot", warn: "bg-warn/12 text-warn", plum: "bg-plum/12 text-plum", muted: "bg-muted text-muted-foreground" };
const STROKE: Record<Tone, string> = { live: "var(--tone-live)", info: "var(--tone-info)", hot: "var(--tone-hot)", warn: "var(--tone-warn)", plum: "var(--tone-plum)", muted: "var(--muted-foreground)" };

export const toneText = (t: Tone) => TEXT[t];

export function Status({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium", SOFT[tone], className)} data-slot="status">
      <span className={cn("size-1.5 rounded-full", BG[tone])} />
      {children}
    </span>
  );
}

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", BG[tone], className)} aria-hidden />;
}

/** An image when the record has a real one; initials for a person; an icon tile for a thing. */
export function Thumb({ src, name, icon, tone = "muted", size = "md", className }: { src?: string | null; name?: string; icon?: LucideIcon; tone?: Tone; size?: "sm" | "md" | "lg" | "xl"; className?: string }) {
  const [broken, setBroken] = React.useState(false);
  let Icon = icon;
  const box = { sm: "size-8 rounded-md text-xs", md: "size-10 rounded-lg text-sm", lg: "size-12 rounded-lg text-sm", xl: "size-16 rounded-xl text-base" }[size];
  if (src && !broken)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" onError={() => setBroken(true)} className={cn("shrink-0 object-cover", box, className)} />;
  // Records without a real name ("Customer ···1hpu") get a person icon, not meaningless initials.
  if (!Icon && name && /^(customer|לקוח)(?=\s|$)/i.test(name.trim())) Icon = UserRoundIcon;
  if (Icon) return <span className={cn("flex shrink-0 items-center justify-center", box, tone === "muted" ? "bg-surface-2 text-muted-foreground" : SOFT[tone], className)} aria-hidden><Icon className={size === "sm" ? "size-4" : "size-[18px]"} /></span>;
  const initials = (name ?? "").split(/\s+/).map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? "").join("").slice(0, 2).toUpperCase() || "·";
  return <span className={cn("flex shrink-0 items-center justify-center bg-surface-2 font-medium text-foreground/85", box, className)} aria-hidden>{initials}</span>;
}

/** A number that settles in once when it changes on a re-read. */
export function Count({ value, className }: { value: React.ReactNode; className?: string }) {
  const first = React.useRef(true);
  const key = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  const [animate, setAnimate] = React.useState(false);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t0 = setTimeout(() => setAnimate(true), 0);
    const t1 = setTimeout(() => setAnimate(false), 500);
    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
    };
  }, [key]);
  return <span className={cn("tabular-nums", animate && "ui-count inline-block", className)}><bdi>{value}</bdi></span>;
}

/** A sparkline from a real series (oldest first). All-zero series draw as a flat baseline. */
export function Spark({ values, tone = "live", width = 96, height = 28, area = true, className }: { values: number[]; tone?: Tone; width?: number; height?: number; area?: boolean; className?: string }) {
  const id = React.useId();
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 2 - ((v - min) / span) * (height - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const flat = max === 0;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn("shrink-0 overflow-visible rtl:-scale-x-100", className)} aria-hidden>
      {area && !flat && (
        <>
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={STROKE[tone]} stopOpacity="0.28" />
              <stop offset="1" stopColor={STROKE[tone]} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />
        </>
      )}
      <path d={line} fill="none" stroke={flat ? "var(--border)" : STROKE[tone]} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Small bars from a real series (oldest first). */
export function Bars({ values, tone = "live", height = 28, className }: { values: number[]; tone?: Tone; height?: number; className?: string }) {
  const max = Math.max(1, ...values);
  return (
    <span className={cn("flex shrink-0 items-end gap-[3px] rtl:flex-row-reverse", className)} style={{ height }} aria-hidden>
      {values.map((v, i) => <span key={i} className={cn("w-[5px] rounded-[1.5px]", v ? BG[tone] : "bg-border")} style={{ height: v ? Math.max(3, (v / max) * height) : 2, opacity: v ? 0.55 + 0.45 * (i / Math.max(1, values.length - 1)) : 1 }} />)}
    </span>
  );
}

export function Progress({ value, max, tone = "info", className }: { value: number; max: number; tone?: Tone; className?: string }) {
  const p = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <span className={cn("block h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <span className={cn("block h-full rounded-full transition-[width] duration-700", BG[tone])} style={{ width: `${p * 100}%` }} />
    </span>
  );
}

/** A surface with an optional header (title · count · action link). */
export function Panel({ title, count, countTone = "muted", action, className, bodyClassName, children }: { title?: React.ReactNode; count?: number; countTone?: Tone; action?: { label: string; href?: string; onClick?: () => void }; className?: string; bodyClassName?: string; children: React.ReactNode }) {
  return (
    <section className={cn("min-w-0 rounded-xl border bg-card", className)}>
      {title && (
        <header className="flex items-center gap-2 px-3.5 pb-0.5 pt-3 sm:px-5 sm:pb-1 sm:pt-4">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {count !== undefined && count > 0 && <span className={cn("text-sm font-medium tabular-nums", TEXT[countTone])}>{count}</span>}
          {action &&
            (action.href ? (
              <Link href={action.href} className="ms-auto flex items-center gap-0.5 text-sm text-info hover:underline">{action.label}<ChevronRightIcon className="size-4 rtl:rotate-180" /></Link>
            ) : (
              <button type="button" onClick={action.onClick} className="ms-auto flex items-center gap-0.5 text-sm text-info hover:underline">{action.label}<ChevronRightIcon className="size-4 rtl:rotate-180" /></button>
            ))}
        </header>
      )}
      <div className={cn("p-2 sm:p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

/** A compact metric: icon · value · label, with an optional real micro-chart. */
export function Metric({ label, value, sub, tone = "muted", icon: Icon, chart, href, onClick, testId }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; icon?: LucideIcon; chart?: React.ReactNode; href?: string; onClick?: () => void; testId?: string }) {
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        {Icon && <Icon className={cn("mb-1 size-4", TEXT[tone])} />}
        <span className={cn("truncate text-2xl font-semibold leading-none tracking-tight", tone === "muted" ? "text-foreground" : TEXT[tone])}><Count value={value} /></span>
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        {sub && <span className="truncate text-xs text-muted-foreground/80">{sub}</span>}
      </span>
      {chart && <span className="self-end">{chart}</span>}
    </>
  );
  const cls = "flex min-w-0 items-stretch gap-3 rounded-xl border bg-card p-4 text-start transition-colors";
  if (href) return <Link href={href} className={cn(cls, "hover:bg-surface-2")} data-testid={testId}>{body}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className={cn(cls, "hover:bg-surface-2")} data-testid={testId}>{body}</button>;
  return <div className={cls} data-testid={testId}>{body}</div>;
}

/** "Live" only because the page really re-reads the records on a timer. */
export function LiveIndicator({ at, syncing, label = "Live" }: { at: Date | null; syncing: boolean; label?: string }) {
  const time = at ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : null;
  return (
    <span className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="live-indicator" title={time ? `Last read ${time}` : undefined}>
      <span className={cn("size-2 rounded-full", syncing ? "bg-muted-foreground" : "bg-live")} />
      <span className="text-foreground/90">{label}</span>
      {time && <span className="hidden tabular-nums sm:inline">{time}</span>}
    </span>
  );
}
