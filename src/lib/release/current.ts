import type { AcceptanceManifest } from "./manifest";

/**
 * THE ACCEPTANCE MANIFEST for the current candidate — authored with each build pass from what changed
 * and how it was proven. Deterministic and local proof are the build lane's; live proof is Work's.
 * Keep it compact: Work should enter a pass knowing the few things that really need live proof.
 */
export const ACCEPTANCE_MANIFEST: AcceptanceManifest = {
  candidate: "Owner WhatsApp Command Channel: verified owner identity → business binding → one semantic owner command service (web + WhatsApp) → grounded operations through the proactive executor, exact-revision approvals, stop, rules to Train BARRY, proactive briefs, Control Room continuity",
  domainsChanged: ["owner channel (owner line adapter, identity links + codes, gateway)", "owner command model + service (reads, operations, approvals, stop, rules, traces)", "owner operations (cohort grounding, lifecycle, holds)", "operator executor (cohort-restricted dueNow runs, owner holds, WhatsApp 24h window)", "owner briefs (decision notices, finished operations, daily)", "owner read model (ownerOperations, ownerCommands, owner channel state)", "revenue outcomes (follow-ups no longer counted as cases)", "UI (command bar → server service, owner operations on Today, WhatsApp link in Settings, deep links)", "store (migration 0016 record kinds)"],
  riskAreas: ["an unlinked / revoked / foreign number must never reach a business", "a WhatsApp approval must resolve only the exact current revision, once", "an operation must never contact anyone outside its grounded eligible cohort, nor twice", "plan, owner rules and founder pause must block operations from WhatsApp exactly as elsewhere", "migration 0016 must be applied on Preview before owner records persist on Supabase", "BARRY_WHATSAPP_OWNER_NUMBERS must not be a customer line"],
  implemented: [
    "Owner identity: one-time code from a signed-in owner sent FROM the number (hash-only, 15 min, single use); one business per link; revoke; owner-token rotation ends links; multi-business owners are asked which business",
    "Owner line adapter (text + interactive buttons), distinct from customer lines; provider-neutral transport contract",
    "One command service for web and WhatsApp: idempotent by provider message id / request id, structured trace per command",
    "Reads from the owner read model: who needs me, what are you working on, money (verified / pending / test apart), waiting customers, a customer's status and payment, an operation's progress",
    "Operations: grounded cohort with reasons, plan + rules + founder controls, >10 waits for Start, executed by the proactive executor on exactly those keys; lifecycle, progress from records; stop holds the cohort (scheduled runs too)",
    "Approvals from WhatsApp: stored single-use prompt per exact approval revision and recipient; stale / forged / foreign / replayed fail; executes via resumeAfterApproval once",
    "Rules from WhatsApp are prepared only and deep-link to Train BARRY's reviewed path",
    "Proactive briefs with dedupe; outside WhatsApp's 24-hour window the blocker is recorded instead of sending",
    "Control Room: owner operations on Today ('Owner command · From WhatsApp'), command bar and Ask run through the same service, Settings link/revoke, deep links to operation / decision / conversation; HQ inspector API",
  ],
  deterministicallyProven: [
    "owner-command-channel (15): unregistered / revoked / rotated-access / unverified senders rejected; code single-use + expiry; A can't operate B; multi-business asks; owner vs customer lines; web = WhatsApp intent and reply; cohort grounding + executor once + duplicate inbound + re-run never re-contacts; follow-ups aren't outcomes; plan / founder pause block; stop + holds + forged action; approval once (announce dedupe, tap, replay, double tap); forged / foreign / stale approvals; 24h window blocker; rule not applied; trace steps; no founder / economics leakage; links carry no authority",
    "owner-control-room, design-language-v1 and all previous suites green",
  ],
  locallyProven: ["Local dev server, owner line in DRY RUN (nothing sent): signed webhooks as the owner's phone — forged signature 401; stranger rejected; web code → LINK linked; stranger replaying the code rejected; reads (needs you with Approve/Decline, working, money, 'Did Dana pay?'); 'recover everyone who abandoned a cart today' grounded 2 → contacted 2 with full trace; duplicate inbound = duplicate; Approve tap approved once ('Already done' on re-tap, duplicate on replay, stranger rejected); operation status; stop; rule prepared; daily brief dry_run. Browser: Today shows 'Owner command · From WhatsApp' with the live flow; web command bar answered by the same service; Settings shows the linked ···2233 in test mode"],
  liveProofRequired: [
    { id: "owner_link_live", title: "Link a real owner WhatsApp number on Preview (Settings → code → send LINK from the phone); a different phone is rejected; revoke stops it", why: "Real Meta-verified sender + migration 0016 on Preview", where: "/owner/settings, owner line", risk: "high" },
    { id: "owner_reads_live", title: "From WhatsApp: 'Who needs me?', 'What are you working on?', 'How much did we make today?' match the Control Room exactly", why: "Same read model over real records", where: "owner line + /owner", risk: "high" },
    { id: "owner_operation_live", title: "'Recover today's abandoned carts' on Rina: cohort with reasons, contacted once (WhatsApp customers within 24h only), visible on Today as From WhatsApp; re-send = no second contact; stop holds", why: "Executor + live sender + holds on Supabase", where: "owner line + /owner", risk: "high" },
    { id: "owner_approval_live", title: "Discount approval announced on WhatsApp; Approve once → customer priced once; second tap 'Already done'; decided on web first → WhatsApp tap stale", why: "Exact-revision prompts against the live approval lifecycle", where: "owner line, /simulator, /owner?tab=actions", risk: "high" },
    { id: "owner_plan_block_live", title: "Emulate CORE on Rina → 'recover carts' from WhatsApp is blocked in owner words, nothing sent", why: "Plan entitlement through the owner channel", where: "/hq/commercial/fashion-retailer + owner line", risk: "medium" },
    { id: "owner_brief_window", title: "Daily brief within 24h of the owner's last message sends once; after 24h it is recorded as blocked (template needed)", why: "WhatsApp window rule on the real line", where: "POST /api/owner/briefs, /api/hq/owner-commands", risk: "medium" },
  ],
  knownUnverified: ["No real WhatsApp delivery from the build environment (owner line exercised in dry run with signed local webhooks)", "Supabase migration 0016 not applied by the build lane", "No WhatsApp message templates configured — proactive messages outside 24h are blocked by design", "Command interpretation is deterministic (semantic classes); no model-backed interpretation yet", "Preview unreachable from the build environment"],
  doNotRetest: ["Living interface visuals (05e13a7)", "Owner control-room IA, Inbox story, approval card (f619e00)", "Commercial lifecycle, entitlements, value accounting (e8cd6b3)", "Train BARRY → effective runtime authority (cd6f741)"],
  knownBlockers: [],
};
