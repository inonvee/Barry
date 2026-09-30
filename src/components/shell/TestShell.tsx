"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useBusiness } from "./useBusiness";

/**
 * The shared navigation + status strip for every testing surface: where you are, which business, and the
 * truth about this deployment (environment, AI, storage, owner access, WhatsApp, payments). Status comes
 * from /api/qa/status (never secrets; absent on Vercel Production).
 */

export type ShellSection = "simulator" | "owner" | "train" | "connections" | "learn" | "qa" | "hq";

const NAV: { id: ShellSection; href: string; label: string }[] = [
  { id: "simulator", href: "/simulator", label: "Customer simulator" },
  { id: "connections", href: "/connections", label: "Connections" },
  { id: "learn", href: "/learnbusiness", label: "Learn business" },
  { id: "qa", href: "/qa", label: "QA tools" },
  { id: "hq", href: "/hq", label: "HQ" },
];

type Status = {
  build: { commit: string | null; runtime: string };
  environment: string;
  qaMode: boolean;
  reasoner: { mode: string; model?: string | null; effort?: string | null; composer?: string | null; configError?: string; error?: string };
  storage: string;
  ownerAccess: { configured: boolean; businesses: string[] };
  whatsapp: { state: string };
  business?: { id: string; ai: { status: string; summary: string }; payments: string; whatsapp: string; ownerAccess: string };
};

export function useQaStatus(businessId: string) {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/qa/status${businessId ? `?businessId=${encodeURIComponent(businessId)}` : ""}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);
  return status;
}

const TONE = {
  good: "bg-[#ecfdf3] text-[#067647] ring-[#abefc6]",
  warn: "bg-[#fffaeb] text-[#b54708] ring-[#fedf89]",
  bad: "bg-[#fef3f2] text-[#b42318] ring-[#fecdca]",
  neutral: "bg-[#f2f4f7] text-[#344054] ring-[#e4e7ec]",
} as const;

function Chip({ label, value, tone, title }: { label: string; value: string; tone: keyof typeof TONE; title?: string }) {
  return (
    <span title={title} className={`inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] ring-1 ring-inset ${TONE[tone]}`}>
      <span className="font-semibold uppercase tracking-wide opacity-70">{label}</span>
      <span className="truncate">{value}</span>
    </span>
  );
}

const aiTone = (s?: string): keyof typeof TONE => (s === "healthy" ? "good" : s === "unavailable" ? "bad" : s === "degraded" ? "warn" : "neutral");

export function TestShell({ active, children, right }: { active: ShellSection; children?: ReactNode; right?: ReactNode }) {
  const { businesses, businessId, setBusinessId } = useBusiness();
  const status = useQaStatus(businessId);
  return (
    <div className="border-b border-[#e4e7ec] bg-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-3 py-2 md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded bg-[#fffaeb] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#b54708]">Internal tools</span>
          <Link href="/owner" className="shrink-0 whitespace-nowrap rounded-md border border-[#d0d5dd] bg-white px-2 py-0.5 text-[12px] font-medium text-[#344054]">
            Owner product ›
          </Link>
          <Link href="/simulator" className="shrink-0 text-sm font-bold tracking-tight text-[#101828]">
            BARRY
          </Link>
          <nav className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {NAV.map((n) => (
              <Link key={n.id} href={n.href} className={`whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] font-medium ${active === n.id ? "bg-[#1d2939] text-white" : "text-[#475467] hover:bg-[#f2f4f7]"}`}>
                {n.label}
              </Link>
            ))}
          </nav>
          {right}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <label className="flex items-center gap-1.5 text-[12px] text-[#475467]">
            <span className="font-semibold uppercase tracking-wide opacity-70">Business</span>
            <select aria-label="Current business" value={businessId} onChange={(e) => setBusinessId(e.target.value)} className="max-w-[12rem] rounded-md border border-[#d0d5dd] bg-white px-2 py-0.5 text-[13px] font-medium text-[#101828]">
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          {status && (
            <>
              <Chip label="Env" value={status.environment} tone={status.environment === "production" ? "bad" : "neutral"} />
              <Chip label="AI" value={status.business?.ai.status.replace(/_/g, " ") ?? status.reasoner.mode} tone={status.reasoner.configError || status.reasoner.error ? "bad" : aiTone(status.business?.ai.status)} title={status.business?.ai.summary ?? status.reasoner.configError} />
              <Chip label="Model" value={status.reasoner.model ? `${status.reasoner.model}${status.reasoner.composer && status.reasoner.composer !== status.reasoner.model ? ` / ${status.reasoner.composer}` : ""}` : status.reasoner.mode} tone={status.reasoner.mode === "live model" ? "good" : "warn"} />
              <Chip label="Storage" value={status.storage.split(" ")[0]} tone={status.storage.startsWith("durable") ? "good" : "warn"} title={status.storage} />
              <Chip label="Owner" value={status.business?.ownerAccess ?? (status.ownerAccess.configured ? "configured" : "missing")} tone={status.business?.ownerAccess === "own token configured" ? "good" : status.ownerAccess.configured ? "warn" : "bad"} />
              <Chip label="WhatsApp" value={status.business?.whatsapp ?? status.whatsapp.state} tone={status.whatsapp.state === "live sending" ? "good" : status.whatsapp.state === "missing" ? "neutral" : "warn"} />
              {status.business && <Chip label="Payments" value={status.business.payments} tone={status.business.payments.startsWith("real") ? "good" : status.business.payments === "not used" ? "neutral" : "warn"} />}
              {status.qaMode && <Chip label="QA" value="tools on" tone="warn" />}
              <Chip label="Build" value={status.build.commit ? status.build.commit.slice(0, 7) : "local"} tone="neutral" />
            </>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
