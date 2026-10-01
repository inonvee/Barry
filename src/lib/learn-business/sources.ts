import { getBackend } from "@/lib/store";
import type { LearnedFactRecord, OperatorRecord } from "@/lib/store/types";

/**
 * SOURCE INTAKE — every owner-approved source Learn Business ingests is a durable record with an id,
 * a type, who approved it and when, when it was last read, its freshness and status, and provenance.
 * Types the architecture can ingest safely today: a website URL (bounded safe fetch), the connected
 * catalog (schema only, through the commerce connector), an uploaded policy / price document (text
 * the owner supplied), connected-system metadata (what the system itself reports) and structured
 * facts the owner typed. Nothing is fetched or believed without the owner's approval of the source.
 */

export type LearnedSourceType = "website" | "catalog" | "document" | "connected_system" | "owner_facts";
export type LearnedSourceStatus = "approved" | "fetched" | "failed" | "disappeared" | "revoked";
export type SourceFreshness = "fresh" | "aging" | "stale" | "unknown";

export type LearnedSource = {
  id: string;
  businessId: string;
  type: LearnedSourceType;
  /** The URL, document name, system key or "owner" — never content. */
  ref: string;
  approvedBy: string;
  approvedAt: string;
  lastFetchedAt?: string;
  lastSucceededAt?: string;
  status: LearnedSourceStatus;
  /** How many facts the latest read produced, and the last error (sanitized). */
  lastResult?: { facts: number; rejected: number; error?: string };
  provenance: { kind: "owner_approval" | "connected_system" | "fixture"; detail?: string };
  createdAt: string;
  updatedAt: string;
};

const FRESH_MS = 7 * 24 * 3600_000;
const STALE_MS = 30 * 24 * 3600_000;

/** Freshness from the last successful read (pure). */
export function sourceFreshness(source: Pick<LearnedSource, "lastSucceededAt" | "status">, now: Date): SourceFreshness {
  if (source.status === "disappeared" || source.status === "revoked") return "stale";
  if (!source.lastSucceededAt) return "unknown";
  const age = now.getTime() - Date.parse(source.lastSucceededAt);
  return age <= FRESH_MS ? "fresh" : age <= STALE_MS ? "aging" : "stale";
}

export function sourceIdFor(type: LearnedSourceType, ref: string): string {
  return `${type}:${ref.trim().toLowerCase().slice(0, 200)}`;
}

function fromRecord(r: OperatorRecord): LearnedSource {
  return r.data as unknown as LearnedSource;
}

export async function listSources(businessId: string): Promise<LearnedSource[]> {
  const records = await getBackend().listOperatorRecords(businessId, "learning_source");
  return records.map(fromRecord).filter((s) => s && typeof s.id === "string").sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Register (or re-approve) a source. Idempotent per (type, ref): approval is refreshed, history kept. */
export async function approveSource(input: { businessId: string; type: LearnedSourceType; ref: string; approvedBy: string; provenance?: LearnedSource["provenance"]; now?: Date }): Promise<LearnedSource> {
  const at = (input.now ?? new Date()).toISOString();
  const id = sourceIdFor(input.type, input.ref);
  const prior = (await listSources(input.businessId)).find((s) => s.id === id);
  const source: LearnedSource = {
    ...(prior ?? { createdAt: at }),
    id,
    businessId: input.businessId,
    type: input.type,
    ref: input.ref.trim(),
    approvedBy: input.approvedBy,
    approvedAt: at,
    status: prior && prior.status !== "revoked" ? prior.status : "approved",
    provenance: input.provenance ?? prior?.provenance ?? { kind: "owner_approval" },
    updatedAt: at,
    createdAt: prior?.createdAt ?? at,
  };
  await getBackend().upsertOperatorRecord({ businessId: input.businessId, kind: "learning_source", key: id, data: source });
  return source;
}

export async function recordSourceRead(input: { businessId: string; id: string; ok: boolean; facts?: number; rejected?: number; error?: string; disappeared?: boolean; now?: Date }): Promise<LearnedSource | undefined> {
  const at = (input.now ?? new Date()).toISOString();
  const prior = (await listSources(input.businessId)).find((s) => s.id === input.id);
  if (!prior) return undefined;
  const next: LearnedSource = {
    ...prior,
    lastFetchedAt: at,
    ...(input.ok ? { lastSucceededAt: at } : {}),
    status: input.ok ? "fetched" : input.disappeared ? "disappeared" : "failed",
    lastResult: { facts: input.facts ?? 0, rejected: input.rejected ?? 0, ...(input.error ? { error: input.error.slice(0, 200) } : {}) },
    updatedAt: at,
  };
  await getBackend().upsertOperatorRecord({ businessId: input.businessId, kind: "learning_source", key: next.id, data: next });
  return next;
}

export async function revokeSource(businessId: string, id: string, now = new Date()): Promise<LearnedSource | undefined> {
  const prior = (await listSources(businessId)).find((s) => s.id === id);
  if (!prior) return undefined;
  const next: LearnedSource = { ...prior, status: "revoked", updatedAt: now.toISOString() };
  await getBackend().upsertOperatorRecord({ businessId, kind: "learning_source", key: id, data: next });
  return next;
}

/** The source a fact stands on, as a source id (for freshness / disappearance checks). */
export function factSourceId(fact: Pick<LearnedFactRecord, "source">): string | null {
  const s = fact.source;
  switch (s.kind) {
    case "web":
      return sourceIdFor("website", s.url);
    case "document":
      return s.sourceId ?? sourceIdFor("document", s.name);
    case "system":
      return s.sourceId ?? sourceIdFor("connected_system", s.system);
    case "catalog":
      return s.sourceId ?? sourceIdFor("catalog", s.provider);
    case "owner":
      return null;
  }
}

/** Owner-facing words for a source. */
export function sourceWords(fact: Pick<LearnedFactRecord, "source">): string {
  const s = fact.source;
  switch (s.kind) {
    case "web":
      return s.title ? `${s.title} (${s.url})` : s.url;
    case "document":
      return `document “${s.name}”`;
    case "system":
      return `${s.system} (its own record ${s.reference})`;
    case "catalog":
      return `the connected catalog (${s.provider})`;
    case "owner":
      return "you";
  }
}
