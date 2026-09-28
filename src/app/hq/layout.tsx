import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "BARRY HQ",
  robots: { index: false, follow: false },
};

export default function HqLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-full bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">{children}</div>;
}
