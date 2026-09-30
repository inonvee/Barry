"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The business being tested — ONE selection shared by every surface (simulator, owner, Train BARRY,
 * connections, learn business, QA), kept for this browser tab so switching pages never loses it.
 */

export type BusinessSummary = { id: string; name: string; description?: string };

const KEY = "barry.business";
const EVENT = "barry:business";

function read(): string {
  try {
    return window.sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function useBusiness() {
  const [businesses, setBusinesses] = useState<BusinessSummary[]>([]);
  const [businessId, setId] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/simulator/businesses")
      .then((r) => r.json())
      .then((data: { businesses: BusinessSummary[] }) => {
        if (cancelled) return;
        const saved = read();
        setBusinesses(data.businesses);
        setId(saved && data.businesses.some((b) => b.id === saved) ? saved : (data.businesses[0]?.id ?? ""));
      })
      .catch(() => {
        if (!cancelled) setBusinesses([]);
      });
    const onChange = (e: Event) => setId((e as CustomEvent<string>).detail);
    window.addEventListener(EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(EVENT, onChange);
    };
  }, []);

  const setBusinessId = useCallback((id: string) => {
    try {
      window.sessionStorage.setItem(KEY, id);
    } catch {
      // storage unavailable: the selection just isn't remembered
    }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
  }, []);

  return { businesses, businessId, setBusinessId, business: businesses.find((b) => b.id === businessId) };
}
