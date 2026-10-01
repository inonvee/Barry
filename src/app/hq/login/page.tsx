import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { HQ_COOKIE, hqConfig, hqSessionValid, safeHqNext } from "@/lib/hq/auth";
import { SignInButton } from "@/components/hq/SignInButton";

export default async function HqLoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  await connection();
  if (!hqConfig().enabled) notFound();
  const { error, next: rawNext } = await searchParams;
  const next = safeHqNext(rawNext);
  // Already signed in (another tab, the back button): go straight on — never ask for the token again.
  if (hqSessionValid((await cookies()).get(HQ_COOKIE)?.value)) redirect(next);
  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-xl font-semibold">BARRY HQ</h1>
      <p className="mt-1 text-sm text-neutral-500">Founder access only. Read-only view across every business.</p>
      <form action="/api/hq/session" method="post" className="mt-6 space-y-3">
        <input type="hidden" name="next" value={next} />
        <input
          name="token"
          type="password"
          autoComplete="current-password"
          required
          placeholder="Founder token"
          className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2.5 text-base sm:text-sm"
        />
        {error && <p className="text-sm text-red-600">That token was not accepted.</p>}
        <SignInButton />
      </form>
    </main>
  );
}
