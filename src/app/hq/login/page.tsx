import { notFound } from "next/navigation";
import { connection } from "next/server";
import { hqConfig } from "@/lib/hq/auth";

export default async function HqLoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await connection();
  if (!hqConfig().enabled) notFound();
  const { error } = await searchParams;
  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-xl font-semibold">BARRY HQ</h1>
      <p className="mt-1 text-sm text-neutral-500">Founder access only. Read-only view across every business.</p>
      <form action="/api/hq/session" method="post" className="mt-6 space-y-3">
        <input
          name="token"
          type="password"
          autoComplete="current-password"
          required
          placeholder="Founder token"
          className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
        />
        {error && <p className="text-sm text-red-600">That token was not accepted.</p>}
        <button type="submit" className="w-full rounded-lg bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 px-3 py-2 text-sm font-medium">
          Sign in
        </button>
      </form>
    </main>
  );
}
