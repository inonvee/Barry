"use client";

import { NextFrame } from "@/components/next/NextFrame";
import { HomeNext } from "@/components/next/HomeNext";
import { useOwnerLang } from "@/components/owner/lang";

/** Home in the new shell — real workspace data and the same owner actions. Not linked from the current UI. */
export default function NextHomePage() {
  const { t } = useOwnerLang();
  return <NextFrame active="home" title={t("Home", "בית")}>{(ctx) => <HomeNext {...ctx} />}</NextFrame>;
}
