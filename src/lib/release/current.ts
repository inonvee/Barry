import type { AcceptanceManifest } from "./manifest";

/**
 * THE ACCEPTANCE MANIFEST for the current candidate — authored with each build pass from what changed
 * and how it was proven. Deterministic and local proof are the build lane's; live proof is Work's.
 * Keep it compact: Work should enter a pass knowing the few things that really need live proof.
 */
export const ACCEPTANCE_MANIFEST: AcceptanceManifest = {
  candidate: "Commercialization + design-partner operating system: plans and entitlements, commercial account / activation / free month, cost-to-serve and unit economics, value accounting, HQ Commercial, owner plan + value",
  domainsChanged: ["commercial (plans, entitlements, account + audit, billing boundary, cost ledger, model usage meter + rate card, economics, value, alerts, readiness, owner view)", "policy (decide(): plan entitlement after authority — can only remove availability)", "runtime (entitlement loaded per turn; every model call metered and recorded per turn)", "operator (proactive executor respects the plan)", "hq (Commercial fleet + business pages, /api/hq/commercial)", "owner (Settings: plan + monthly value; /api/owner/plan; Money hides SAVED outside Intelligence)", "qa (self-checking commercial scenarios on sandbox ids)", "store (migration 0015 record kinds)"],
  riskAreas: ["plan logic must never loosen authority (plan denial = UNAVAILABLE, authority denial = DENIED)", "the free month must not start before setup is paid / waived and readiness (or an audited override)", "owner surfaces must never show cost, margin or AI economics", "migration 0015 must be applied on Preview before commercial records persist on Supabase"],
  implemented: [
    "Canonical plan catalog (Core $399 / Operator $899 / Intelligence $1,799; setup from $750 / $1,500 / $3,000; Custom per deal), versioned feature snapshots, guardrails",
    "Plan entitlement enforced next to authority in decide() and the proactive executor; QA-only plan emulation",
    "Commercial account + append-only audit; deterministic activation; 30-day free month from activation; pause extends it; founding price lock; plan change review",
    "Vendor-neutral billing boundary with a manual V1 (never auto-charges; separate from tenant payments)",
    "Cost-to-serve ledger (measured / estimated / unavailable), per-turn model usage (provider-reported tokens × versioned rate card), support minutes (estimated)",
    "Unit economics: recurring vs setup apart, gross contribution / margin per currency, guardrail + margin-target flags; founder alerts (9 kinds)",
    "Value accounting HANDLED / MADE / SAVED / NEEDS YOU; owner Settings 'This month BARRY' + plan / locked / upgrade request; free-month trial summary",
    "HQ Commercial fleet + per-business founder flow; design-partner commercial readiness (READY TO START FREE MONTH / NOT READY + exact blocker); docs/BUSINESS_MODEL_V1.md",
  ],
  deterministicallyProven: [
    "commercial-operability (23): entitlement truth table (unavailable / denied / executable) + runtime CORE add-to-cart unavailable with no cart and no owner request; QA emulation; lifecycle + audit + manual billing; free month never burnt, pause extends, override audited; founding lock; readiness blockers; model usage metering + rate card + unpriced model; cost labels; economics math (free days 0, setup apart, margin, guardrail); value contracts; owner view has no economics; 10 commercial QA scenarios PASS",
    "previous suites unchanged and green (train-to-runtime authority, founder control plane, policy, operator V2, owner OS)",
  ],
  locallyProven: ["Local dev server (memory store, local founder token): founder flow via /api/hq/commercial — activation refused before setup paid, refused by the server-recomputed gate with the exact blocker, started with an audited override; costs MEASURED / ESTIMATED / UNAVAILABLE; all 10 commercial QA scenarios PASS; /hq/commercial, /hq/commercial/fashion-retailer and /owner/settings render at 390px with no horizontal overflow; the owner plan API carries no economics"],
  liveProofRequired: [
    { id: "plan_vs_authority", title: "Plan entitlement vs authority: emulate CORE on Rina (HQ → Commercial → QA) → 'add the Midnight in M' is unavailable (no cart, no owner request); OPERATOR → it works; pause writes → denied", why: "decide() with the durable entitlement on Preview", where: "/hq/commercial/fashion-retailer, /simulator", risk: "high" },
    { id: "activation_free_month", title: "Setup paid → activation → 30-day free period: choose plan, quote, mark paid, start the free month (override reason if NOT READY) → day 1 of 30, end date, recurring planned", why: "Commercial workflow on Supabase across requests", where: "/hq/commercial/fashion-retailer", risk: "high" },
    { id: "commercial_persistence", title: "Commercial persistence + audit: reload on another instance → same account; history shows who / when / why for every step; plan change audited", why: "Migration 0015 on Preview; durable operator records", where: "/hq/commercial/fashion-retailer", risk: "high" },
    { id: "model_usage_record", title: "Real Preview model usage: one live simulator turn → AI usage line shows provider-reported tokens and an ESTIMATED cost on rates-2026-10-v1", why: "Live OpenAI usage block + per-turn metering", where: "/simulator → /hq/commercial/fashion-retailer", risk: "high" },
    { id: "contribution_math", title: "Gross contribution math: record a MEASURED hosting cost and support minutes → cost lines labelled MEASURED / ESTIMATED / UNAVAILABLE, contribution and margin consistent", why: "Economics on real records", where: "/hq/commercial/fashion-retailer", risk: "medium" },
    { id: "owner_value_truth", title: "Owner value summary: Settings shows plan, plan-locked items, 'This month BARRY' from verified records only, and no cost / margin / AI figures", why: "Owner allow-list on Preview data", where: "/owner/settings (Rina)", risk: "medium" },
    { id: "commercial_alerts", title: "HQ commercial alerts: run the QA scenarios (guardrail breach, trial ending, Intelligence without cost evidence) → each PASS; Rina shows real alerts", why: "Alerts from durable records", where: "/hq/commercial/fashion-retailer (QA section)", risk: "medium" },
    { id: "readiness_gate", title: "Design-partner readiness gate: NOT READY with the exact first blocker until plan, setup, launch gate and supervision are in place; READY TO START FREE MONTH after", why: "Commercial gate over the real launch checklist", where: "/hq/commercial/fashion-retailer", risk: "high" },
  ],
  knownUnverified: ["Preview deployment unreachable from the build environment; live model usage unverified (no OPENAI_API_KEY)", "Supabase migration 0015 not applied by the build lane", "No real billing provider (manual by design)"],
  doNotRetest: ["Train BARRY → effective runtime authority and pre-cart discount (cd6f741)", "Capability expansion surfaces (e946291)", "Named cart subject binding, checkout consent, F31 held approvals, tenant isolation, HQ founder auth (faf79a9, 49fe8d3)"],
  knownBlockers: [],
};
