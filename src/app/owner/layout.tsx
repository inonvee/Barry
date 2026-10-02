import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { OwnerLangProvider } from "@/components/owner/lang";
import { LANG_COOKIE, parseLangCookie } from "@/lib/owner/lang";

/** The Owner OS: every page renders in the owner's chosen language and direction from the first byte. */
export default async function OwnerLayout({ children }: { children: ReactNode }) {
  const chosen = parseLangCookie((await cookies()).get(LANG_COOKIE)?.value);
  return (
    <OwnerLangProvider initial={chosen ?? "en"} chosen={Boolean(chosen)}>
      {children}
    </OwnerLangProvider>
  );
}
