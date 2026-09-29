import { listCapabilities } from "@/lib/fabric/capability";
import type { ComposeResponseInput, ReasonerContext } from "./types";

/**
 * Reply hygiene — a customer never sees BARRY's machinery.
 *
 * This is NOT phrase parsing of what the customer said, and it doesn't judge tone: it only
 * recognises BARRY's OWN identifiers (which the runtime knows exactly) inside an outgoing reply.
 * The vocabulary is derived from the business and the runtime (its capability surface, the
 * capability and tool registries, the Genome's authority/policy rule ids, the raw enum values this
 * turn's system results carried, the rule text behind an approval) — never a hand-written list of
 * business words.
 */

export type InternalVocabulary = {
  /** Exact identifiers (capability ids, tool/action names, rule ids, raw enum values). */
  identifiers: string[];
  /** Internal free text that must not be quoted (e.g. the rule behind an approval). */
  phrases: string[];
};

/** Runtime words that only ever describe BARRY's internals, in any business. */
const INTERNAL_TERMS = /\b(capabilit(?:y|ies)|connectors?|invokeCapability|toolOutput|toolResult|toolError|policyReason|not_permitted|requires_approval|owner_approval|capabilityRequest)\b/i;

/** A token that is plainly an identifier rather than a word: has a dot/underscore/hyphen or inner capital. */
function looksLikeIdentifier(token: string): boolean {
  return token.length >= 4 && (/[._-]/.test(token) || /[a-z][A-Z]/.test(token));
}

const RAW_ENUM = /^[a-z]+(?:_[a-z]+)+$/;

function collectRawEnums(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (RAW_ENUM.test(value)) into.add(value);
    return;
  }
  if (Array.isArray(value)) value.slice(0, 50).forEach((v) => collectRawEnums(v, into, depth + 1));
  else if (typeof value === "object") Object.values(value as Record<string, unknown>).forEach((v) => collectRawEnums(v, into, depth + 1));
}

export function internalVocabulary(
  ctx: Pick<ReasonerContext, "graph" | "grounded">,
  input: ComposeResponseInput,
  /** Runtime identifiers the caller knows (e.g. the tool registry's names). */
  runtimeIdentifiers: string[] = []
): InternalVocabulary {
  const ids = new Set<string>(runtimeIdentifiers);
  for (const c of ctx.grounded?.capabilities ?? []) ids.add(c.id);
  for (const c of listCapabilities()) ids.add(c.id);
  for (const a of ctx.graph.availableActions) ids.add(a.name);
  for (const r of ctx.graph.authority ?? []) ids.add(r.id);
  for (const p of ctx.graph.policies) ids.add(p.id);
  const enums = new Set<string>();
  for (const c of ctx.grounded?.capabilities ?? []) for (const i of c.inputs) for (const o of i.options ?? []) if (RAW_ENUM.test(o)) enums.add(o);
  collectRawEnums(input.toolResult, enums);
  for (const st of input.steps ?? []) collectRawEnums(st.toolResult, enums);
  // The owner-facing reasons written on the business's authority rules are internal too.
  const phrases = [input.policyReason, ...(input.steps ?? []).map((st) => st.policyReason), ...(ctx.graph.authority ?? []).map((r) => r.reason)].filter((p): p is string => typeof p === "string" && p.trim().length >= 12);
  return { identifiers: [...[...ids].filter(looksLikeIdentifier), ...enums], phrases };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first internal thing a reply exposes, or undefined when it's clean. */
export function findInternalLeak(text: string, vocab: InternalVocabulary): string | undefined {
  const term = text.match(INTERNAL_TERMS);
  if (term) return `internal term "${term[0]}"`;
  for (const id of vocab.identifiers) {
    if (new RegExp(`(?<![\\w.@-])${escape(id)}(?![\\w-]|\\.\\w)`).test(text)) return `internal identifier "${id}"`;
  }
  const lower = text.toLowerCase();
  for (const phrase of vocab.phrases) {
    if (lower.includes(phrase.trim().toLowerCase().replace(/[.!]+$/, ""))) return "quoted internal rule text";
  }
  return undefined;
}
