import type { Money } from "@/lib/owner/revenue";

/**
 * MONEY IN THE PRODUCT — amounts are shown PER CURRENCY and never added across currencies. A figure
 * with two currencies is two figures, side by side, never one "total". Zero and "no money" are distinct
 * from "unavailable" (the caller decides what to say when a source failed).
 */

export type MoneyPart = { currency: string; amount: number; text: string };

export function formatAmount(amount: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale ?? "en", { style: "currency", currency, maximumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** One part per currency with a positive amount, stable order (largest first). Empty when nothing. */
export function moneyParts(m: Money | undefined | null, locale?: string): MoneyPart[] {
  return Object.entries(m ?? {})
    .filter(([, v]) => typeof v === "number" && v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([currency, amount]) => ({ currency, amount, text: formatAmount(amount, currency, locale) }));
}

export function hasMoney(m: Money | undefined | null): boolean {
  return moneyParts(m).length > 0;
}

/**
 * Words for a money map: "₪420" · "₪420 and $30" (two figures, explicitly NOT a sum) · `empty` when none.
 * Never uses "+" or a combined number.
 */
export function moneyWords(m: Money | undefined | null, opts: { empty?: string; locale?: string } = {}): string {
  const parts = moneyParts(m, opts.locale);
  if (parts.length === 0) return opts.empty ?? "none";
  if (parts.length === 1) return parts[0].text;
  return `${parts.slice(0, -1).map((p) => p.text).join(", ")} and ${parts.at(-1)!.text}`;
}

/** Per-currency addition of money maps (the only legal way to combine): currencies never mix. */
export function addMoney(...maps: (Money | undefined)[]): Money {
  const out: Money = {};
  for (const m of maps) for (const [c, v] of Object.entries(m ?? {})) if (typeof v === "number" && v > 0) out[c] = Math.round(((out[c] ?? 0) + v) * 100) / 100;
  return out;
}
