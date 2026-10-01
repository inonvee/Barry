import type { AcceptanceManifest } from "./manifest";

/**
 * THE ACCEPTANCE MANIFEST for the current candidate — authored with each build pass from what changed
 * and how it was proven. Deterministic and local proof are the build lane's; live proof is Work's.
 * Keep it compact: Work should enter a pass knowing the few things that really need live proof.
 */
export const ACCEPTANCE_MANIFEST: AcceptanceManifest = {
  candidate: "Overnight launch push: HQ sign-in / navigation loop fixed, commercial truth (no silent zero cost, 'at most' contribution), two false readiness blockers removed, Founder BARRY conversation layer (verified composer, multi-turn, Hebrew)",
  domainsChanged: ["HQ auth (Lax session cookie, proxy.ts path hint, login next / pending state, loading states)", "commercial economics + HQ commercial wording", "owner readiness (catalog offers, Genome policy coverage)", "founder conversation layer (voice.ts, previousKey context, Hebrew intents, scan wording)", "scheduler route (cookie-only GET refused)"],
  riskAreas: ["the session cookie is now Lax: every HQ mutation must stay POST and no cookie-authenticated GET may act", "sign-in redirects only to an HQ path (no open redirect)", "a composer reply must never state a number, business, action or send the envelope doesn't hold", "'yes' may confirm only the previous turn's still-pending control", "readiness must not turn READY without evidence (simulators still block)"],
  implemented: [
    "HQ auth: Lax session cookie (Strict dropped the session on every link opened from another app → login loop); /hq/login?next= carried through one session exchange (validated to an HQ path); signed-in visit to login goes straight on; sign-in button disables while pending; HQ + commercial-detail loading states; scheduler GET needs an Authorization header; /hq/ask?q= auto-runs reads only",
    "Commercial truth: cost in another currency (or none) = UNAVAILABLE, never 0 → contribution / margin null; plan contribution and fleet rows say 'at most' when cost is incomplete; costs shown in the account's currency; unpriced AI calls named",
    "Readiness: a connected catalog search counts as 'what the business offers' (simulators still block in the systems checks); a Genome policy text (e.g. returns) answers the matching learn-business question",
    "Founder conversation layer: immutable envelope → optional model composer in the founder's language → checkComposed (numbers incl. thousands, foreign businesses, action / send claims, confirmation, proposals) → grounded fallback; previousKey follow-ups ('and X?', 'the other one', 'yes', 'is that real money?'); Hebrew intents; natural initiative-scan wording",
  ],
  deterministicallyProven: [
    "hq-auth-navigation (8): Lax / httpOnly / 12h / rotation; safe next (off-site, protocol-relative, login, API → /hq); one 303 to the requested page with the cookie; invalid token keeps next and sets no cookie; proxy path hint; cookie-only GET tick refused, POST + bearer allowed",
    "commercial-truth-gate (8): economics over the exact live Rina usage records (v1 null unpriced, v2 0.02938 counted, $0.03 ESTIMATED lower bound); no silent conversion / zero; server recomputes the activation gate and ignores a client 'ready'",
    "readiness-catalog-offers (3) · founder-conversation (13): follow-ups, the other one, yes-confirms-pending-only, stale context, real-money basis, Hebrew + code-switching, composer accept / reject / fallback, Hebrew composer keeps the confirmation",
    "all previous suites green",
  ],
  locallyProven: [
    "Mobile browser (iPhone 13 emulation): unauthenticated /hq/commercial/fashion-retailer → /hq/login?next=… → invalid token keeps next → valid token lands on the page (2 session posts total); link opened from another site keeps the session (was: bounced to login); Fleet → Rina row 342×98 px, tap lands in 321 ms; 5 round trips, no login bounce",
    "All 10 commercial QA scenarios PASS over the real HTTP route (/api/hq/commercial qa_scenario) on the local server",
  ],
  liveProofRequired: [
    { id: "hq_mobile_auth", title: "iPhone: open /hq/commercial/fashion-retailer from a chat app link → sign in once → lands on the Rina commercial page; open the link again → no login", why: "The Strict-cookie login loop is the live failure being fixed", where: "/hq/commercial/fashion-retailer", risk: "high" },
    { id: "hq_commercial_tap", title: "HQ → Commercial: tap Rina's row on a phone → the detail opens (loading state shows first)", why: "Mobile navigation", where: "/hq/commercial", risk: "medium" },
    { id: "founder_voice_live", title: "Ask BARRY 'What do I need to know today?' and 'מה קורה עם Rina?' → natural reply; the trace shows voice=composer or a recorded rejection reason", why: "Model composer only runs with the live model", where: "/hq/ask, founder_command records", risk: "medium" },
    { id: "founder_followups_live", title: "Ask about Rina, then 'and Midtown?', then 'Pause Midtown' → 'yes' → paused + audited; 'yes' again does nothing", why: "Multi-turn context on durable storage", where: "/hq/ask", risk: "high" },
  ],
  knownUnverified: ["Preview unreachable from the build environment (live items above are Work's)", "Model composer not exercised against a live model (no key in the build environment); its checker is", "Owner WhatsApp replies intentionally not routed through the new composer (live-proven path left unchanged)"],
  doNotRetest: ["Founder BARRY Control Plane V1 (2d3c01b)", "Initiative scan bridge + scheduler (e680392, 11b2a83)", "Rate card v2 (3ae6c8b)", "Owner WhatsApp Command Channel (e564d0e)"],
  knownBlockers: [],
};
