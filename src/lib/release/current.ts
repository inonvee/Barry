import type { AcceptanceManifest } from "./manifest";

/**
 * THE ACCEPTANCE MANIFEST for the current candidate — authored with each build pass from what changed
 * and how it was proven. Deterministic and local proof are the build lane's; live proof is Work's.
 * Keep it compact: Work should enter a pass knowing the few things that really need live proof.
 */
export const ACCEPTANCE_MANIFEST: AcceptanceManifest = {
  candidate: "Initiative Engine V1: evidence-backed things BARRY notices on his own — bounded scans (≤3 per business-local day), 7 detectors, verification from record references, dedupe + fatigue, ranking, Today 'BARRY noticed', Ask BARRY, founder API",
  domainsChanged: ["initiative (model, detectors, scan engine, store, research boundary)", "owner read model (initiatives)", "owner command model (query topic 'initiatives')", "Today (one 'BARRY noticed' card)", "opportunities (exported isAtRisk)", "store (migration 0017 record kinds)"],
  riskAreas: ["no initiative may state a number its record references don't prove", "test / simulated money must never appear as money in an initiative", "a dismissed initiative must not keep coming back", "'Do this' must never bypass plan / authority — it runs the owner command service", "migration 0017 must be applied on Preview before initiatives persist on Supabase"],
  implemented: [
    "Initiative model: category, detector, subject, observation, basis, evidence refs (ids only), metric, provenance (scan, business-local date, window), confidence, importance, impact, recommendation, entitlement, authority, can-act, fingerprint, lifecycle, snooze / dismissal, result",
    "Scan engine: business-local snapshot → detect → verify (counts recomputed from references; money only from real records) → dedupe → fatigue (dismissed quiet 14 days unless materially new; snooze; ≤2 surfaced per day, ≤3 at once) → rank → persist; ≤3 scans per local day (founder can force for QA)",
    "Detectors: repeated question (+ conversion friction), unanswered questions, abandoned demand (reuses obligations), repeat approvals (standing-rule suggestion), product interest vs purchases, real money at risk, verified cost rise / evidence needed",
    "Plans change what BARRY can do, not what it notices; 'Do this' runs through the owner command service",
    "Today 'BARRY noticed' card; Ask BARRY answers from persisted initiatives; WhatsApp-compatible message renderer (not sent); founder API with scans + quality metrics",
  ],
  deterministicallyProven: [
    "initiative-engine (15): empty scan = zero + quiet UI; one repeated question = one initiative updated in place; conversion friction counted; unanswered questions from runtime records; dismissed suppressed, reopened only after the quiet period with materially new evidence; snooze; 3 scans per business-local day across the UTC boundary; tenants isolated (foreign references fail); test money never money; CORE observes but can't act (and the command pipeline blocks); 'Do this' via the command service, idempotent, measured; repeat approvals suggest a rule without changing authority; money / cost / research truth; ranking order; Ask BARRY reads persisted initiatives",
    "all previous suites green",
  ],
  locallyProven: ["Local dev server (Rina, mock reasoner, simulated providers): empty scan → 0 initiatives; after seeding carts + 3 approved discounts → abandoned demand, product interest, repeat approvals (2 surfaced, 1 held by the daily cap); rescan → 0 created, 3 updated; dismiss → suppressed on the next (forced) scan; 4th scan of the day skipped; owner can't force; 6 returns questions → repeated-question initiative verified but held by the daily surface cap; Ask 'What did you notice today?' and 'Where am I losing money?' answered from records; Today card at 1440 / 390 with no overflow"],
  liveProofRequired: [
    { id: "initiative_quiet", title: "On a quiet Preview business a scan creates nothing and Today shows no 'BARRY noticed' card", why: "Empty scan is success on real data", where: "POST /api/owner/initiatives/scan, /owner", risk: "medium" },
    { id: "initiative_real_data", title: "On Rina with real traffic: initiatives match the records exactly (open the evidence conversations / requests and count)", why: "Detectors over live records", where: "/api/hq/initiatives, /owner", risk: "high" },
    { id: "initiative_fatigue", title: "Dismiss an initiative, scan again later the same day and the next day → stays dismissed unless the evidence grows materially after 14 days", why: "Fatigue on Supabase-persisted records", where: "/owner, /api/hq/initiatives", risk: "medium" },
    { id: "initiative_act", title: "'Do this' on abandoned checkouts runs the normal grounded operation (and is refused on CORE)", why: "No execution shortcut", where: "/owner Today, /hq/commercial (plan emulation)", risk: "high" },
  ],
  knownUnverified: ["No scheduler is wired (API is cron-ready)", "Supabase migration 0017 not applied by the build lane", "Real money-at-risk and cost-rise initiatives proven only deterministically (local providers are simulated)", "No external research connector (boundary only)", "Preview unreachable from the build environment"],
  doNotRetest: ["Owner WhatsApp Command Channel (e564d0e)", "Living interface visuals (05e13a7)", "Commercial lifecycle, entitlements, value accounting (e8cd6b3)"],
  knownBlockers: [],
};
