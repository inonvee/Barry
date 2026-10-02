import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Archivo, Geist, Geist_Mono, Heebo } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Hebrew (and mixed Hebrew/English) owner text: Heebo carries both scripts with one rhythm.
const heebo = Heebo({
  variable: "--font-heebo",
  subsets: ["hebrew", "latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The Owner OS voice (art direction "Ops"): Archivo — compact, sharp, with strong tabular figures.
const ops = Archivo({ variable: "--font-ops", subsets: ["latin"], axes: ["wdth"] });

export const metadata: Metadata = {
  title: "BARRY",
  description: "BARRY — universal AI business operator, Phase 1 engineering cockpit",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${heebo.variable} ${ops.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
