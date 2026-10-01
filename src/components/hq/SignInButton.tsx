"use client";

import { useFormStatus } from "react-dom";

/** The founder sign-in button: disabled while the sign-in is in flight, so Enter can't post it twice. */
export function SignInButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className="w-full rounded-lg bg-neutral-900 px-3 py-2.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900">
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}
