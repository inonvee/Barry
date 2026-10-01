import type { AcceptanceManifest } from "./manifest";

/**
 * THE ACCEPTANCE MANIFEST for the current candidate — authored with each build pass from what changed
 * and how it was proven. Deterministic and local proof are the build lane's; live proof is Work's.
 * Keep it compact: Work should enter a pass knowing the few things that really need live proof.
 */
export const ACCEPTANCE_MANIFEST: AcceptanceManifest = {
  candidate: "High repair: Train BARRY → effective runtime authority contract (owner-taught discount rule enforced by policy; pre-cart named-product discount → one exact owner approval)",
  domainsChanged: ["policy (effective-rules: static baseline + compiled owner-trained overlay with provenance; decide() carries the governing rule)", "runtime (effective graph at every entry; pre-cart product discount; product-scoped grant applied only at matching checkout)", "tools (grantDiscount on a product, price re-read; checkout prices a product grant and fails closed on a changed price)", "learn-business (effective genome states ACTIVE / NEEDS REVIEW / UNDERSTOOD ONLY / REPLACED / BLOCKED; Train rules section; uncompilable correction of an operational rule refused)", "reasoner (effective discount rule + source in model context)", "owner (approval card / why / after-approval words; workspace and training read the effective graph)", "inspector (discount rule provenance per step)"],
  riskAreas: ["only owner-verified verified/corrected facts can change authority; candidates never do", "an owner-trained limit above BARRY's hard ceiling (30%) is blocked, never active", "a product grant never adds to a cart or starts checkout; a changed price grants / charges nothing"],
  implemented: [
    "One effective-authority resolution (policy/effective-rules) used by the policy engine, reasoner context, Train BARRY, owner cards and the Inspector — no second genome",
    "Bounded compilation of the owner's words into max_auto_discount_pct (exactly one percentage, bare number or none; ambiguous / none / above hard limit → not operational with one clarifying question)",
    "Supersession: newest approved record wins deterministically; every effective rule carries fact id, source kind, reviewer, reviewedAt, revision and what it supersedes",
    "Pre-cart discount on a named product: catalog grounding, single shared price (else ask the option), grantDiscount on the product decided by policy → one owner approval with exact terms; approval records a scoped grant only",
    "Product grant applied later only to that product's cart lines at the granted price; checkout fails closed if the price changed",
    "Train BARRY: 'Rules BARRY enforces' (ACTIVE RULE — … Source: You taught BARRY.), status on every row, approved-but-unused facts shown as UNDERSTOOD ONLY",
    "Inspector: effective max, rule source (static / owner-trained), fact / revision, reviewer, requested %, result and reason",
  ],
  deterministicallyProven: [
    "train-to-runtime-authority (19): compile cases; A teach 5% (4% allowed, 10% approval); B correct to 8% (5% superseded, 6% allowed, 10% approval); C candidate never active, reject keeps rule; D ambiguous / above-limit not operational with a question, runtime unchanged; E several records → one current version; one-source Train / reasoner / owner card; exact live regression (one approval 'Approve 10% off Midnight Wrap Dress (₪420 → ₪378)', no refusal / handoff / cart / checkout; approve once, duplicate no-op; decline no grant); ≤5% granted at once; unknown product clarified; price-varying variants ask the option; revalidation on price change; grant applied only to the matching product at checkout; fails closed (no automatic discount) when learned facts are unreadable",
    "learn-business-v1 updated: an approved fact no runtime rule reads is UNDERSTOOD ONLY, not effective",
    "previous suites unchanged and green",
  ],
  locallyProven: ["Local dev server (memory store): POST /api/learnbusiness/answers with the exact rule → the Train view returns 'ACTIVE RULE — BARRY may offer up to 5% without asking you. More than 5% requires your approval.' with 'Source: You taught BARRY.' and the profile rule as REPLACED; /owner/train renders the 'Rules BARRY enforces' section at phone width (browser smoke)"],
  liveProofRequired: [
    { id: "teach_discount_rule", title: "Train BARRY: teach 'Up to 5% without approval. Anything above 5% requires owner approval.' → shows 'ACTIVE RULE — BARRY may offer up to 5% without asking you. More than 5% requires your approval. Source: You taught BARRY.'", why: "Learned fact on Supabase compiled into the effective rule", where: "/owner/train (Rina)", risk: "high" },
    { id: "precart_discount_approval", title: "Fresh simulator conversation: 'Can you give me 10% off the Midnight Wrap Dress?' → exactly one owner approval 'Approve 10% off Midnight Wrap Dress (₪420 → ₪378)'; Inspector shows the owner-trained rule", why: "Live model must carry discountPct + the product subject; runtime grounds and asks the owner", where: "/simulator → /owner approvals → Inspector", risk: "high" },
    { id: "approve_no_checkout", title: "Approve → customer told the discount applies when they order; no cart line, no checkout, no payment link unless separately requested", why: "Approval grants a scoped entitlement only", where: "/owner → /simulator Inspector", risk: "high" },
  ],
  knownUnverified: ["Preview deployment unreachable from the build environment; live model path unverified (no OPENAI_API_KEY) — the live model must extract discountPct and the product subject for 'X% off <product>'", "Train BARRY page not browser-checked in this pass"],
  doNotRetest: ["Capability expansion surfaces (e946291): Learn Business V1 sources, operator V2, channels, HQ V2, profit operator, fabric, locale", "Named cart subject binding, checkout consent boundary, cart discount approval, F31 held-approval flow, tenant isolation, HQ founder auth (faf79a9, 49fe8d3)"],
  knownBlockers: [],
};
