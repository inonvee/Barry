"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusPill, type Status } from "./primitives";

/**
 * UNIVERSAL COMMAND BAR — a palette on desktop (⌘K / Ctrl+K), a bottom sheet on phones. Every result
 * is a real record or a real surface from a read model; nothing is pretended searchable. The caller
 * provides the static surfaces and (optionally) an async search over its scope.
 */

export type CommandKind = "business" | "surface" | "incident" | "conversation" | "approval" | "payment" | "ask" | "action";

export type CommandResult = {
  id: string;
  kind: CommandKind;
  title: string;
  subtitle?: string;
  href: string;
  status?: Status;
  /** Words that match besides the title (ids, customer, business). */
  keywords?: string[];
};

export const KIND_WORDS: Record<CommandKind, string> = {
  business: "Business",
  surface: "Go to",
  incident: "Incident",
  conversation: "Conversation",
  approval: "Approval",
  payment: "Payment",
  ask: "Ask",
  action: "Action",
};

export function matchesQuery(r: CommandResult, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [r.title, r.subtitle ?? "", ...(r.keywords ?? [])].join(" ").toLowerCase();
  return needle.split(/\s+/).every((w) => hay.includes(w));
}

/** Pure ranking over local results: kind order then title match position. */
export function rankResults(results: CommandResult[], q: string, limit = 12): CommandResult[] {
  const order: CommandKind[] = ["business", "incident", "approval", "payment", "conversation", "surface", "action", "ask"];
  const needle = q.trim().toLowerCase();
  return results
    .filter((r) => matchesQuery(r, q))
    .sort((a, b) => {
      const pa = needle ? a.title.toLowerCase().indexOf(needle) : 0;
      const pb = needle ? b.title.toLowerCase().indexOf(needle) : 0;
      const sa = pa === 0 ? 0 : 1;
      const sb = pb === 0 ? 0 : 1;
      return sa - sb || order.indexOf(a.kind) - order.indexOf(b.kind);
    })
    .slice(0, limit);
}

export function CommandBar(props: { open: boolean; onClose: () => void; items: CommandResult[]; search?: (q: string) => Promise<CommandResult[]>; askHref?: (q: string) => string; askLabel?: string; placeholder?: string }) {
  // Mounted fresh on every open, so its state starts clean without effects.
  return props.open ? <Panel {...props} /> : null;
}

function Panel({ onClose, items, search, askHref, askLabel = "Ask BARRY", placeholder = "Switch business, go to a surface, find a conversation…" }: { onClose: () => void; items: CommandResult[]; search?: (q: string) => Promise<CommandResult[]>; askHref?: (q: string) => string; askLabel?: string; placeholder?: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<CommandResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!search) return;
    const term = q.trim();
    const mine = ++seq.current;
    const t = setTimeout(() => {
      if (term.length < 2) {
        setRemote([]);
        setBusy(false);
        return;
      }
      setBusy(true);
      search(term)
        .then((r) => {
          if (seq.current === mine) setRemote(r);
        })
        .catch(() => {
          if (seq.current === mine) setRemote([]);
        })
        .finally(() => {
          if (seq.current === mine) setBusy(false);
        });
    }, 180);
    return () => clearTimeout(t);
  }, [q, search]);

  const results = useMemo(() => {
    const local = rankResults(items, q);
    const merged = [...remote, ...local.filter((l) => !remote.some((r) => r.id === l.id))].slice(0, 14);
    if (askHref && q.trim().length >= 3) merged.push({ id: "ask", kind: "ask", title: `${askLabel}: “${q.trim()}”`, href: askHref(q.trim()) });
    return merged;
  }, [items, remote, q, askHref, askLabel]);

  const go = useCallback(
    (r: CommandResult) => {
      onClose();
      router.push(r.href);
    },
    [onClose, router]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(results.length - 1, c + 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      }
      if (e.key === "Enter" && results[cursor]) {
        e.preventDefault();
        go(results[cursor]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [results, cursor, go, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#101828]/40 backdrop-blur-[2px] md:items-start md:pt-[12vh]" onClick={onClose} role="presentation">
      <div role="dialog" aria-modal="true" aria-label="Command bar" className="flex max-h-[80vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl md:max-h-[60vh] md:max-w-xl md:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-[#f2f4f7] px-4 py-3">
          <span aria-hidden className="text-[#98a2b3]">⌕</span>
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(0);
            }}
            placeholder={placeholder}
            aria-label="Search"
            className="min-h-10 min-w-0 flex-1 bg-transparent text-[16px] text-[#101828] placeholder:text-[#98a2b3] focus:outline-none"
            autoComplete="off"
          />
          <button onClick={onClose} className="rounded-md px-2 py-1 text-[12px] text-[#667085] hover:bg-[#f2f4f7]" aria-label="Close">
            Esc
          </button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox">
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-[#667085]">{busy ? "Searching…" : q.trim().length >= 2 ? "Nothing in your scope matches. Businesses, surfaces, incidents, conversations, approvals and payments are searchable; raw logs are not." : "Type to search, or pick a surface below."}</li>
          )}
          {results.map((r, i) => (
            <li key={r.id} role="option" aria-selected={i === cursor}>
              <button onMouseEnter={() => setCursor(i)} onClick={() => go(r)} className={`flex w-full items-center gap-3 px-4 py-3 text-left ${i === cursor ? "bg-[#f4f5f7]" : ""}`}>
                <span className="w-20 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[#98a2b3]">{KIND_WORDS[r.kind]}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] font-medium text-[#101828]">{r.title}</span>
                  {r.subtitle && <span className="truncate text-[12px] text-[#667085]">{r.subtitle}</span>}
                </span>
                {r.status && <StatusPill status={r.status} />}
              </button>
            </li>
          ))}
        </ul>
        <div className="hidden items-center justify-between border-t border-[#f2f4f7] px-4 py-2 text-[11px] text-[#98a2b3] md:flex">
          <span>↑↓ move · ↵ open · esc close</span>
          <span>Only your scope · real records only</span>
        </div>
      </div>
    </div>
  );
}

/** ⌘K / Ctrl+K opens the command bar. */
export function useCommandBar() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen, close: useCallback(() => setOpen(false), []) };
}
