import type { AcceptanceManifest } from "./manifest";

/**
 * THE ACCEPTANCE MANIFEST for the current candidate — authored with each build pass from what changed
 * and how it was proven. Deterministic and local proof are the build lane's; live proof is Work's.
 * Keep it compact: Work should enter a pass knowing the few things that really need live proof.
 */
export const ACCEPTANCE_MANIFEST: AcceptanceManifest = {
  candidate: "Fable fast-lane mega build (HQ control plane, QA fast lane, proactive operator, design-partner control)",
  domainsChanged: ["hq (fleet, incidents, controls, ask)", "release lane (manifest, cockpit, verdicts)", "qa (scenario factory, test-owner sign-in, reset)", "operator (obligations)", "owner (Today/Money/conversation obligations)", "policy (founder controls tighten authority)", "channels (disabled channel)", "store (operator_records, QA purge)", "finance (impact foundation)"],
  riskAreas: ["policy tightening must never loosen authority", "QA purge must touch only qa: records", "test-owner sign-in must be unavailable outside QA mode", "fleet aggregation cost per business"],
  implemented: [
    "HQ fleet overview with exceptions first (who needs me, what broke, what changed, money blocked, not ready)",
    "Incident read model with deterministic severity, dedupe, acknowledge / resolve / reopen",
    "Founder controls: mode, pause consequential writes, human-only, pause capability, disable channel — audited, reversible, enforced in policy and channel gateway",
    "Ask HQ BARRY (read-only, briefing-verified)",
    "QA scenario factory (Preview/QA only), test-owner session bootstrap, QA data reset",
    "Acceptance manifest + release state machine + Work verdict recording (release cockpit in HQ and /qa)",
    "Operational obligations: durable, derived, reconciled, with next-move ownership; Today / Money / conversation integration",
    "Business operating mode, design-partner launch checklist, READY FOR SUPERVISED DESIGN PARTNER gate",
    "Profit / margin foundation: financial impact states, cost evidence contract, profit opportunity model (zero without evidence)",
  ],
  deterministicallyProven: [
    "policy: founder controls only tighten (allowed → requires_approval / denied; denied stays denied); reads unaffected by write pause",
    "incidents: derivation, severity rules, dedupe, acknowledge / resolve / reopen after recurrence",
    "fleet: summary exceptions from business statuses; tenant scoping of business detail",
    "obligations: derivation from records, no duplicates, lifecycle closure with evidence (paid → completed, declined → cancelled, newer revision → superseded)",
    "qa: scenario runs create only qa:-tagged records; reset purges only those; owner sign-in bootstrap refuses outside QA mode",
    "release: state machine (tests never produce LIVE PASSED; only a recorded verdict does)",
    "launch gate: evidence-based checklist; unknown stays UNKNOWN",
    "owner: Today shows what BARRY is watching from the same obligations; conversation shows next expected action",
    "commerce and tenant suites unchanged from the repaired baseline (faf79a9)",
  ],
  locallyProven: ["HQ overview, business detail, Ask HQ and /qa render locally (server render + browser smoke)"],
  liveProofRequired: [
    { id: "hq_fleet", title: "HQ overview on Preview shows the fleet with exceptions first and the release cockpit for this SHA", why: "Founder token + Preview env + durable store", where: "/hq", risk: "high" },
    { id: "founder_controls", title: "Pause consequential writes on Rina → a checkout is refused; resume → allowed; audit shows both", why: "Durable controls read by a different serverless instance than the one that wrote them", where: "/hq/fashion-retailer → Founder controls; simulator checkout", risk: "high" },
    { id: "qa_scenarios", title: "QA scenario 'Rina discount approval > limit' creates the approval card and links; reset removes only qa: records", why: "Live model may understand the scripted turns differently; store purge on Supabase", where: "/qa → Scenarios", risk: "high" },
    { id: "test_owner", title: "Sign in as Rina test owner from /qa without pasting a token; Production refuses", why: "Cookie issuance on the real host", where: "/qa", risk: "medium" },
    { id: "obligations", title: "Unpaid link → Today 'BARRY is watching' shows it; after the simulated payment it completes with evidence", why: "Reconciliation across requests on the durable store", where: "/owner (Today, Money) after the Rina payment-pending scenario", risk: "medium" },
    { id: "incidents", title: "Force an understanding failure twice → HQ incident appears; acknowledge; resolve", why: "Incident state records across instances", where: "/qa force failure → /hq/[business]#incidents", risk: "medium" },
    { id: "launch_gate", title: "Rina launch checklist and gate reflect real Preview configuration (owner access, storage, model, channel)", why: "Reads the Preview environment", where: "/hq/fashion-retailer#launch", risk: "medium" },
    { id: "commerce", title: "One Rina commerce smoke (named add, offer-then-explicit checkout) still passes under founder mode SUPERVISED", why: "Mode/controls must not change customer behaviour unless a control is set", where: "/simulator", risk: "medium" },
  ],
  knownUnverified: ["Live model behaviour of new prompts is unchanged (none added); Ask HQ model answers need OPENAI_API_KEY", "Supabase migration 0012 must be applied before durable controls / obligations / verdicts persist"],
  doNotRetest: ["Named cart subject binding, checkout consent boundary, discount approval, Money/Ask reconciliation, Train BARRY owner copy (repaired and proven on faf79a9; untouched here)", "F31 held-approval flow, tenant isolation, owner product shell (unchanged code paths, suites green)"],
  knownBlockers: [],
};
