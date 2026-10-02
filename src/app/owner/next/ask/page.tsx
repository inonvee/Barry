"use client";

import { NextFrame } from "@/components/next/NextFrame";
import { AskNext } from "@/components/next/AskNext";
import { useOwnerLang } from "@/components/owner/lang";

/** Ask BARRY in the new shell — the same owner command service as WhatsApp. Not linked from the current UI. */
export default function NextAskPage() {
  const { t } = useOwnerLang();
  return <NextFrame active="ask" title={t("Ask BARRY", "שאל את BARRY")}>{(ctx) => <AskNext {...ctx} />}</NextFrame>;
}
