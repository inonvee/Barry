"use client";

import { NextFrame } from "@/components/next/NextFrame";
import { MoneyNext } from "@/components/next/MoneyNext";
import { useOwnerLang } from "@/components/owner/lang";

/** Money in the new shell — the same money read model and honesty rules. Not linked from the current UI. */
export default function NextMoneyPage() {
  const { t } = useOwnerLang();
  return <NextFrame active="money" title={t("Money", "כסף")}>{(ctx) => <MoneyNext {...ctx} />}</NextFrame>;
}
