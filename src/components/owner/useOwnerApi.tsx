"use client";

import { useCallback, useEffect, useState } from "react";

const TOKEN_KEY = "barry.ownerToken";
const BUSINESS_KEY = "barry.ownerBusiness";

function read(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function write(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // storage unavailable — the value just isn't remembered
  }
}

export type BusinessSummary = { id: string; name: string };

/** Owner token (kept in this tab's session only) + business selection + an authenticated fetch helper. */
export function useOwnerApi() {
  const [token, setTokenState] = useState("");
  const [businessId, setBusinessIdState] = useState("");
  const [businesses, setBusinesses] = useState<BusinessSummary[]>([]);

  useEffect(() => {
    fetch("/api/simulator/businesses")
      .then((r) => r.json())
      .then((data: { businesses: BusinessSummary[] }) => {
        setTokenState(read(TOKEN_KEY));
        const saved = read(BUSINESS_KEY);
        setBusinesses(data.businesses);
        setBusinessIdState(saved && data.businesses.some((b) => b.id === saved) ? saved : data.businesses[0]?.id ?? "");
      })
      .catch(() => setBusinesses([]));
  }, []);

  const setToken = (value: string) => {
    setTokenState(value);
    write(TOKEN_KEY, value);
  };
  const setBusinessId = (value: string) => {
    setBusinessIdState(value);
    write(BUSINESS_KEY, value);
  };

  const call = useCallback(
    async <T,>(url: string, init?: { method?: string; body?: unknown }): Promise<T> => {
      const res = await fetch(url, {
        method: init?.method ?? (init?.body ? "POST" : "GET"),
        headers: { "content-type": "application/json", ...(token ? { "x-barry-owner-token": token } : {}) },
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      return data;
    },
    [token]
  );

  return { token, setToken, businessId, setBusinessId, businesses, call };
}

export function OwnerBar({ api, title, subtitle }: { api: ReturnType<typeof useOwnerApi>; title: string; subtitle: string }) {
  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-[#667085]">Owner workspace</p>
        <h1 className="mt-2 text-2xl font-semibold md:text-3xl">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm text-[#475467] md:text-base">{subtitle}</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          aria-label="Business"
          value={api.businessId}
          onChange={(e) => api.setBusinessId(e.target.value)}
          className="rounded-md border border-[#d0d5dd] bg-white px-3 py-2 text-sm"
        >
          {api.businesses.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <input
          aria-label="Owner token"
          type="password"
          value={api.token}
          onChange={(e) => api.setToken(e.target.value)}
          placeholder="Owner token"
          autoComplete="off"
          className="rounded-md border border-[#d0d5dd] bg-white px-3 py-2 text-sm"
        />
      </div>
    </header>
  );
}
