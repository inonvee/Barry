import type { AcceptanceManifest } from "./manifest";

/**
 * THE ACCEPTANCE MANIFEST for the current candidate — authored with each build pass from what changed
 * and how it was proven. Deterministic and local proof are the build lane's; live proof is Work's.
 * Keep it compact: Work should enter a pass knowing the few things that really need live proof.
 */
export const ACCEPTANCE_MANIFEST: AcceptanceManifest = {
  candidate: "Design Language V1 + operability (HQ Focus/Fleet/Incidents/Activity/Money/Releases, business focus mode, command bar, since-last-visit, activity read model, focused founder controls, owner refinement)",
  domainsChanged: ["design system (primitives, shell, command bar, tokens)", "hq (information architecture, focus, fleet rows, incidents, activity, money, releases, settings, business focus views)", "founder controls (focused actions, no-op audit)", "founder state (migration 0013: last visit, pins, recents)", "qa (expected-block outcome)", "owner (shell, Today money line, Money brief + BARRY MADE/SAVED shell, Settings split, Train copy)", "format (business-timezone time, per-currency money)"],
  riskAreas: ["migration 0013 must be applied before founder state (since-visit, pins, recents) persists on Supabase", "search API cost: one query set per tenant per keystroke (debounced)", "visit marking writes during a GET render (15-minute session window)", "owner Settings now lives at /owner/settings; /connections remains the technical page"],
  implemented: [
    "Design Language V1 (docs/DESIGN_LANGUAGE_V1.md) with reusable primitives: AppShell, PrimaryNav, CommandBar, HeroBrief, FocusItem, StatusPill, MetricInline, Timeline/ActivityRow, Section, Disclosure, Sheet, BusinessSwitcher, EmptyState, ActionBar, Confirmation, MobileBottomNav",
    "HQ IA: Focus (default), Fleet (stacked rows on phones), Business focus mode (Overview · Needs attention · Activity · Money · Capabilities · Launch · Controls · Technical), Incidents, Releases, Activity, Money, BARRY, Settings, Ask",
    "BARRY presence layer (working / waiting / needs you / degraded / paused) in both shells",
    "Universal command bar: businesses, surfaces, incidents, conversations, approvals, payments, Ask — real records only, founder scope via /api/hq/search, owner scope from the loaded workspace",
    "Since you were here: durable last-visit snapshot (founder_state) and derived changes only; pins and recents",
    "Live activity read model: effects, approvals, payments, handoffs, obligations, incidents, founder changes — what / for whom / who / verified / still needed, evidence linked",
    "Focused founder-control actions with scope / effect / reversibility / audit; identical state writes no audit",
    "QA expected refusal = EXPECTEDLY BLOCKED · PASS (outcome on the scenario run)",
    "Grouped launch checklist with X ready / Y blocked / Z unknown and one primary blocker",
    "Owner: Today money line (no tiles), Money brief with five distinct figures and BARRY MADE / BARRY SAVED (zero without evidence), Settings separating business setup from team technical config, Train as teaching an operator",
    "Timestamps in the business timezone across HQ and owner; money per currency everywhere (no '+' joins)",
  ],
  deterministicallyProven: [
    "format: business-timezone words (Today / Yesterday / weekday), per-currency money with no cross-currency sum",
    "controls: no-op change writes neither controls nor audit; real changes still audited",
    "qa: checkout scenario under founder pause → expectedly_blocked with the founder policy; created once resumed",
    "search: fleet and business-record scoping; ranking; unsupported types never returned",
    "visits: no snapshot → no claims; derived change kinds and hrefs; pins toggle; recents dedupe",
    "activity: derived rows newest first with actor / evidence / still-needed; never raw turns or messages",
    "focus ranking and headline; presence semantics; fleet row renders without a table; incident priority; launch grouping",
    "founder-control-plane, qa-fast-lane, profit-foundation, hq suites unchanged and green",
  ],
  locallyProven: ["HQ Focus, Fleet, Incidents, Activity, Money, Releases, BARRY, Settings, Ask and the business views render in the browser at 1280 / 430 / 390 px with no horizontal scroll; controls pause → audit → no-op notice → resume; command bar desktop and sheet; QA expected-block pill; Owner Today / Inbox / Money / command bar at 1280 and 390"],
  liveProofRequired: [
    { id: "hq_focus", title: "HQ Focus on Preview: one headline, needs-you list, since-you-were-here (second visit shows derived changes only)", why: "founder_state persistence on Supabase (migration 0013)", where: "/hq (visit twice, 15 min apart or after a change)", risk: "high" },
    { id: "hq_fleet_mobile", title: "Fleet on desktop and at 390px: rows, no table, tap opens business focus", why: "Real fleet data and phone rendering", where: "/hq/fleet", risk: "medium" },
    { id: "business_focus", title: "Business focus sub-navigation (Overview → Needs attention → Activity → Money → Capabilities → Launch → Controls → Technical) with real Rina data", why: "Per-view loads on the durable store", where: "/hq/fashion-retailer", risk: "medium" },
    { id: "command_bar", title: "Command bar (⌘K and the phone sheet) finds Rina, an incident, a conversation and a payment; unsupported terms return nothing", why: "/api/hq/search over the fleet on Supabase", where: "/hq", risk: "medium" },
    { id: "controls_ux", title: "Pause consequential actions with reason → QA checkout scenario shows EXPECTEDLY BLOCKED · PASS → identical re-apply shows 'Nothing changed' (no audit) → resume", why: "Durable controls + no-op audit + QA outcome on a different instance", where: "/hq/fashion-retailer?view=controls, /qa", risk: "high" },
    { id: "activity", title: "Business and fleet Activity list the scenario's effects, the approval and the founder changes with evidence links, times in Asia/Jerusalem", why: "Activity derivation on live records", where: "/hq/fashion-retailer?view=activity, /hq/activity", risk: "medium" },
    { id: "owner_mobile", title: "Owner Today and Money at 390px: brief, inline money line, per-currency figures, BARRY MADE / SAVED, bottom nav + More sheet, Settings split", why: "Phone rendering of the migrated owner shell", where: "/owner?tab=today, /owner?tab=money, /owner/settings", risk: "medium" },
    { id: "releases", title: "Releases surface is apart from business operation: SHA, Preview, state, gates, verdict form; Launch checklist grouped with one primary blocker", why: "Release state on Preview env + grouped gate on real configuration", where: "/hq/releases, /hq/fashion-retailer?view=launch", risk: "medium" },
  ],
  knownUnverified: ["Preview deployment not reachable from the build environment (vercel.app blocked): visual proof is local only", "Supabase migration 0013 not applied by the build lane (founder state falls back to empty on a missing kind)", "Ask HQ / Ask BARRY model answers need OPENAI_API_KEY (briefing fallback proven only)"],
  doNotRetest: ["Named cart subject binding, checkout consent boundary, discount approval, Money/Ask reconciliation, Train BARRY owner copy (faf79a9)", "F31 held-approval flow, tenant isolation, HQ founder auth, migration 0012 records, pause/resume enforcement and audit, QA scenario factory, obligation derivation, supervised mode, release manifest (ae87e6d; untouched runtime paths)"],
  knownBlockers: [],
};
