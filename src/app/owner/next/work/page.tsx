"use client";

import { NextFrame } from "@/components/next/NextFrame";
import { WorkNext } from "@/components/next/WorkNext";
import { useOwnerLang } from "@/components/owner/lang";

/** Work in the new shell — real workspace data and the same owner actions. Not linked from the current UI. */
export default function NextWorkPage() {
  const { t } = useOwnerLang();
  return <NextFrame active="work" title={t("Work", "עבודה")}>{(ctx) => <WorkNext {...ctx} />}</NextFrame>;
}
