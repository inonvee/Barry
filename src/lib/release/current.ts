import type { AcceptanceManifest } from "./manifest";

/**
 * THE ACCEPTANCE MANIFEST for the current candidate — authored with each build pass from what changed
 * and how it was proven. Deterministic and local proof are the build lane's; live proof is Work's.
 * Keep it compact: Work should enter a pass knowing the few things that really need live proof.
 */
export const ACCEPTANCE_MANIFEST: AcceptanceManifest = {
  candidate: "Founder BARRY Control Plane V1: one founder command service over the fleet — grounded reads, Founder Brief, business drilldown, existing founder controls with confirmation + verification, gated proposals, handle-what-you-can, durable trace",
  domainsChanged: ["founder (command model, read model, command service, model interpreter)", "HQ proposals (plan proposals, dedupe — additive)", "HQ Ask page → Ask BARRY", "API /api/hq/founder/command", "store (migration 0018 record kind)"],
  riskAreas: ["a founder action must only run through the existing audited control and only after confirmation", "an ambiguous business must never be acted on", "no fleet fact may be stated that the records don't hold", "plan proposals must never change a business", "migration 0018 must be applied on Preview before founder traces persist on Supabase"],
  implemented: [
    "Founder command model: closed intent families (fleet / business / commercial / value / incident / initiative / release reads, founder action, proposal, handle-safe, unsupported); forbidden requests refused (SQL, env, secrets, deploy, deciding for owners, owner policies); directory-grounded business resolution with ambiguity",
    "Read model: canonical health (paused / degraded / blocked / needs attention / onboarding / not enough evidence / healthy) with reasons; deterministic Founder Brief (quiet when healthy); business drilldown with follow-ups",
    "Command service: idempotent by key; pause / resume / safe mode via applyControlChange after confirmation, verified from durable controls; plan proposals (rollout / runtime / capability / configuration) via HQ proposals, gated and idempotent; handle-what-you-can; durable founder_command trace with redaction",
    "Ask BARRY on /hq/ask: one command field, confirm button, follow-ups; default What needs you / What BARRY handled / What changed; plan details on /hq/proposals",
  ],
  deterministicallyProven: [
    "founder-barry (23): the 12 founder commands interpreted; global vs business scope; forbidden requests refused; ambiguity never guessed; model output schema-checked and carries no authority; canonical health with reasons; brief lists only B degraded / C recurring / D noticed and is quiet on a healthy fleet; drilldown + follow-ups with no cross-tenant content; cost measured / estimated / unavailable; value verified semantics; integrations and initiatives from records only; release grounded; pause → confirm → verified + audited, repeat and re-confirm execute nothing; proposal idempotent and not executable even when approved; handle-what-you-can only proposes; durable trace; secrets redacted; API founder-only",
    "all previous suites green",
  ],
  locallyProven: ["Local QA (fixture fleet, memory store): A healthy / B payments provider in error / C free month over / D initiative → brief lists B, C, D only; Pause Midtown (B) → confirmation → executed + verified + audited, second confirm duplicate; rollout for A + D → gated proposal, A / D controls and audit untouched; dev server: HTTP 401 without founder auth, pause / confirm / duplicate over HTTP; /hq/ask at 1440 and 390 with no horizontal overflow"],
  liveProofRequired: [
    { id: "founder_brief_live", title: "On Preview, 'What do I need to know today?' lists only items you can confirm in HQ (open each link)", why: "Brief over Supabase records", where: "/hq/ask", risk: "medium" },
    { id: "founder_pause_live", title: "Pause and resume a test business from Ask BARRY: confirmation, verified controls, audit entry on the business page", why: "Founder control path on durable storage", where: "/hq/ask, /hq/[businessId]?view=controls", risk: "high" },
    { id: "founder_proposal_live", title: "'Prepare a rollout to <two businesses>' twice → one proposal on /hq/proposals; approving it changes nothing", why: "Idempotent, gated proposals", where: "/hq/proposals", risk: "medium" },
  ],
  knownUnverified: ["Supabase migration 0018 not applied by the build lane", "Model interpreter not exercised live (no API key in the build environment)", "No per-business rollout mechanism — rollout proposals are gated", "Preview unreachable from the build environment"],
  doNotRetest: ["Initiative Engine V1 (a264c79)", "Owner WhatsApp Command Channel (e564d0e)", "Living interface visuals (05e13a7)", "Commercial lifecycle, entitlements, value accounting (e8cd6b3)"],
  knownBlockers: [],
};
