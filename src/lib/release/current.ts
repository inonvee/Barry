import type { AcceptanceManifest } from "./manifest";

/**
 * THE ACCEPTANCE MANIFEST for the current candidate — authored with each build pass from what changed
 * and how it was proven. Deterministic and local proof are the build lane's; live proof is Work's.
 * Keep it compact: Work should enter a pass knowing the few things that really need live proof.
 */
export const ACCEPTANCE_MANIFEST: AcceptanceManifest = {
  candidate: "Capability expansion: Learn Business V1, commerce design-partner V1, proactive operator V2, channels, HQ V2 fleet operations, profit / margin operator V1, fabric hardening, locale hardening",
  domainsChanged: ["learn-business (sources, intake, re-learning, conflicts, effective genome, plays, Train view)", "commerce (discovery, alternatives, aftercare, customer memory, order status)", "operator (follow-up policy, executor, attempts, recovery, new obligation kinds)", "channels (rich replies, verified identity, health, adapters, pause-business)", "hq (console, transactions, approvals, connection health, runtime assignment, proposals, safe mode)", "finance (evidence store, margin, opportunity rules, cost-action contracts, negotiation brief)", "fabric (ontology, transports, stack model, onboarding, composite workflow, re-verification)", "store (migration 0014 record kinds)", "launch gate (sources, reviewed facts, zero blockers)"],
  riskAreas: ["the obligation executor sends real WhatsApp follow-ups only when the sender is LIVE — dry-run everywhere else", "re-learning must never overwrite an owner-approved value (conflict review only)", "proposals activate only BUSINESS / TEMPORARY scopes through the audited control path", "cost actions are contracts only: default deny, nothing executes", "migration 0014 must be applied before the new record kinds persist on Supabase"],
  implemented: [
    "Learn Business V1: source intake (website, catalog, document, connected systems, owner facts) with approval / freshness / status / provenance; fact contract with document / system / catalog sources; continuous re-learning diff with conflict review; conflict / staleness engine; effective Genome (why / where / when / approved); operating plays by availability; Train BARRY view and UI",
    "Commerce: grounded discovery (facets remapped or rejected), guided-selling shortlist + compare, real alternatives (also in the add-to-cart tool), provider-grounded order aftercare, customer commerce memory (observed apart from inferred), order status on the adapter contract",
    "Proactive operator V2: playbook follow-up rules, bounded executor (re-check authority / capability, stale cancel, idempotent attempts, hard limits, evidence), abandoned-checkout and appointment-reminder obligations, revenue recovery states, Owner Today buckets, /api/operator/run",
    "Channels: provider-independent rich replies (no Markdown leaks), verified-only cross-channel identity links used by the gateway, channel health (secret-free) in the fleet status, adapter registry (web, WhatsApp; Instagram declared)",
    "HQ V2: conversation console, transactions, global approvals (visibility only), connection health, runtime / version assignment (auditable), Ask HQ V2 proposals (propose → approve → activate → roll back; GLOBAL / CAPABILITY gated), emergency pause-business and safe-mode controls",
    "Profit / margin V1: normalized cost evidence (validated), margin only with trusted revenue + cost, more opportunity rules (supplier increase, subscription duplication, slow inventory, shipping inefficiency), cost-action contracts with default deny, negotiation brief that cannot be sent without channel + authority + approved objective",
    "Fabric: capability ontology across 11 domains, generic transport boundaries (REST executes; GraphQL / webhook / read-only DB / file / email validate only), stack model, unknown-system onboarding (infer → validate → conformance → approval → activate proven only), composite workflow with one transaction state, re-verification feeding incidents",
    "Locale: deterministic follow-ups and refusals in the customer's language; Hebrew commerce semantics in the corpus",
    "Design-partner gate: approved sources learned, facts / policies reviewed, blockers explicitly zero",
  ],
  deterministicallyProven: [
    "learn-business-v1 (10): intake paths, re-learning conflict kept until decided, blockers, effective genome provenance, plays, Train view words, route approval",
    "proactive-operator-v2 (9): policy caps, dry-run reminder with evidence, attempt limit → owner, stale cancel, safe mode / paused business block, failed send counted, locale texts, abandoned checkout, appointment reminder, recovery states",
    "channels-v2 (6): markdown stripping, adapters, verified-only links, gateway canonical customer, channel health, paused business refused",
    "commerce-design-partner (5): discovery grounding, shortlist / compare, alternatives (pure + tool), aftercare, customer memory",
    "profit-operator (5): evidence validation, margin never guessed, opportunity rules, default-deny cost actions, negotiation brief",
    "fabric-hardening (5): ontology, transports, stack + re-verification + incident, composite workflow, onboarding gates",
    "hq-v2-fleet-operations (4): console filters, read models, runtime assignment, proposals lifecycle",
    "locale-hardening (4): Hebrew / English fallbacks, language stickiness, blocked write in Hebrew, corpus",
    "semantic-evals: Hebrew budget-search group (8 paraphrases) through the real pipeline",
    "previous suites unchanged and green (founder control plane, design language, QA fast lane, owner operating system)",
  ],
  locallyProven: ["Owner Train BARRY page with the new Train view renders locally (browser smoke); HQ console / transactions / approvals / connections / proposals render locally"],
  liveProofRequired: [
    { id: "train_sources", title: "Train BARRY on Preview: approve a website + paste a policy document → facts with provenance; confirm one; re-learn with a changed value → conflict question, approved value kept until decided", why: "Durable sources / changes on Supabase (migration 0014) and the live learner", where: "/owner/train", risk: "high" },
    { id: "operator_run", title: "Unpaid link past the delay → POST /api/operator/run → one DRY-RUN reminder recorded (attempt, ledger, delivery); second run skips; attempts exhausted → Today says it needs you", why: "Executor against durable records on a different instance; no real send without LIVE WhatsApp", where: "/qa (checkout pending) → /api/operator/run → /owner Today", risk: "high" },
    { id: "safe_mode", title: "HQ: proposal 'safe mode' for Rina → approve → activate → QA checkout needs approval (EXPECTEDLY BLOCKED / requires approval) → roll back → audit shows both", why: "Proposal lifecycle + audited controls across requests", where: "/hq/proposals, /qa, /hq/fashion-retailer?view=controls", risk: "high" },
    { id: "pause_business", title: "Pause business from Controls → a simulator message is refused on every channel → resume", why: "Gateway + policy enforcement of the new control", where: "/hq/fashion-retailer?view=controls, /simulator", risk: "medium" },
    { id: "hq_console", title: "HQ console / transactions / approvals / connections show real Preview data with filters and no secrets", why: "Cross-business read models on Supabase", where: "/hq/console, /hq/transactions, /hq/approvals, /hq/connections", risk: "medium" },
    { id: "alternatives", title: "Simulator: ask for the Midnight dress in S → reply offers a real in-stock alternative (M or L), nothing added", why: "Live model must carry the variant; tool returns grounded alternatives", where: "/simulator", risk: "medium" },
    { id: "cost_evidence", title: "POST cost evidence for Rina (founder) → HQ Money shows margin for an order with verified payment + cost, unknown cost apart, opportunities with assumptions", why: "Evidence store + margin view on Supabase", where: "/api/hq/cost-evidence, /hq/fashion-retailer?view=money", risk: "medium" },
    { id: "hebrew_budget", title: "Live model: 'היי אני מחפשת שמלה שחורה מידה M לחתונה עד 400 שקל' → search with size M, ILS budget 400, results in Hebrew", why: "Model semantics on the live reasoner", where: "/simulator (Rina)", risk: "medium" },
  ],
  knownUnverified: ["Preview deployment unreachable from the build environment; live model paths unverified (no OPENAI_API_KEY)", "Supabase migration 0014 not applied by the build lane", "Instagram adapter is declared, not implemented; GraphQL / DB / file / email transports validate but do not execute", "GLOBAL / CAPABILITY proposals are approved-but-gated by design"],
  doNotRetest: ["Named cart subject binding, checkout consent boundary, discount approval, Money/Ask reconciliation, Train BARRY owner copy (faf79a9)", "F31 held-approval flow, tenant isolation, HQ founder auth, migration 0012/0013 records, pause/resume enforcement, audit, QA scenario factory, obligation derivation, supervised mode, release manifest, Design Language V1 surfaces (49fe8d3)"],
  knownBlockers: [],
};
