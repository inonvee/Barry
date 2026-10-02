import type { ReactNode } from "react";
import { Figtree, Hanken_Grotesk, Instrument_Sans } from "next/font/google";

/** Art-direction exploration only (Today, three concepts). Not linked from the product. */
const a = Instrument_Sans({ variable: "--concept-a", subsets: ["latin"] });
const b = Hanken_Grotesk({ variable: "--concept-b", subsets: ["latin"] });
const c = Figtree({ variable: "--concept-c", subsets: ["latin"] });

export default function ConceptsLayout({ children }: { children: ReactNode }) {
  return <div className={`${a.variable} ${b.variable} ${c.variable}`}>{children}</div>;
}
