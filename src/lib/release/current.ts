import type { AcceptanceManifest } from "./manifest";

/**
 * THE ACCEPTANCE MANIFEST for the current candidate — authored with each build pass from what changed
 * and how it was proven. Deterministic and local proof are the build lane's; live proof is Work's.
 * Keep it compact: Work should enter a pass knowing the few things that really need live proof.
 */
export const ACCEPTANCE_MANIFEST: AcceptanceManifest = {
  candidate: "Living interface: BARRY presence (orb states from records), owner command model + command bar (one object for web / WhatsApp / voice), live branching workflow flows, Today as a story, Needs-you float, money in motion with real 7-day trends",
  domainsChanged: ["owner UI (BarryOrb, CommandBar, LiveFlow, Sparkline, MotionStat, StageTitle; Today / Money / Inbox / Ask recomposed; o-stage / o-float / o-command styles)", "owner read model (operator: plan + follow-up rules; trend: verified money per local day)", "owner command model (lib/owner/command: ask / operation / decide / teach / unsupported — never executes)", "presence (unavailable / needs_you / degraded / completed / working / waiting / idle)", "Train BARRY (a rule from the command bar prefills the reviewed document path)"],
  riskAreas: ["a command must never execute or look executed — operations only show the live workflow and whether the rule / plan lets it run", "presence and 'Live' only from open obligations / recent verified outcomes, never decorative", "trend lines only verified real-provider money; test money never in them", "approve from the Needs-you float goes through the same owner endpoint and re-checks"],
  implemented: [
    "BARRY presence orb: ring turns only with open work or a waiting decision, halo breathes while waiting, dims when unavailable; top bar, Today and command bar share ownerPresence()",
    "Command bar 'Tell BARRY what to do…' on Today and Ask: questions → Ask BARRY; operations → the live follow-up workflow + rule (after Xh, N attempts) or 'not in your plan' / 'off in your rules'; approve/decline → opens the decision card; rules → Train BARRY (reviewed before enforced); campaigns → refused",
    "Live workflow flow: cohort → luminous paths → Paid (verified) / Followed up · waiting / Queued / Stopped; paths stream only for live branches; vertical on phones",
    "Today: 'Good afternoon, …' / 'BARRY made ₪X today' (verified only) / 'He's working on N things. One needs you.'; BARRY is working stage beside the Needs-you float and a 'Just happened' stream; 'Your business, in motion' strip",
    "Money: motion strip with Saved (plan-gated) and real 7-day sparklines; 'From BARRY's work to money' flows; four-state savings ladder; fewer boxes",
    "Inbox: one composed list with state rings; Ask auto-asks a question handed over from Today",
  ],
  deterministicallyProven: [
    "owner-control-room (11): command intents (operation running / not in plan / off; ask; teach; decide; unsupported; web and WhatsApp give the same intent), presence order, 7-day trend excludes test and non-revenue money, Today story never claims unverified money, Today renders the live operation / command bar / motion strip",
    "design-language-v1: AI unavailable → presence 'unavailable'; HQ activity pulse test no longer depends on yesterday's date",
    "previous suites unchanged and green",
  ],
  locallyProven: ["Local dev server (memory store, seeded Rina scenarios): Today, Inbox, one conversation, Money, Ask, Actions, Train and Settings at 390px, 1440px and 1920px — 0px horizontal overflow on all 24; command bar driven in a browser: 'Recover today's abandoned carts' → live workflow with the rule, 'Don't offer more than 5% today' → Train BARRY with the rule prefilled, 'Run a campaign…' → refused, 'What happened today?' → Ask answers"],
  liveProofRequired: [
    { id: "presence_truth", title: "Presence on Rina: Needs you while a decision waits; after deciding → Working / Waiting / Ready matching the open obligations; 'Just finished' only after a real verified outcome", why: "ownerPresence on Supabase data", where: "/owner (Rina)", risk: "high" },
    { id: "command_never_executes", title: "Command bar: 'Recover abandoned carts' shows the live workflow and the rule, sends nothing; on a CORE plan it says 'not in your plan'", why: "Command model vs plan entitlement on Preview", where: "/owner Today, /hq/commercial (plan emulation)", risk: "high" },
    { id: "float_approve", title: "Approve from the Needs-you float on mobile: same result as the Actions card (price once, nothing charged by the approval)", why: "Float uses the owner approval endpoint", where: "/owner at 390px, /simulator", risk: "high" },
    { id: "rule_from_command", title: "'Don't offer more than 5% today' → Train BARRY prefilled → Let BARRY read it → shown for review before any enforcement", why: "Reviewed learning path", where: "/owner → /owner/train", risk: "medium" },
    { id: "trend_truth", title: "After a real (non-simulated) verified payment, the Made sparkline shows it on today's point; simulated payments never appear", why: "revenueTrend on real records", where: "/owner?tab=money", risk: "medium" },
    { id: "hq_unchanged", title: "HQ renders as before; HQ Commercial founder flow still works", why: "Shared CSS touched", where: "/hq, /hq/commercial", risk: "medium" },
  ],
  knownUnverified: ["Preview deployment unreachable from the build environment; live model answers in Ask BARRY unverified (no OPENAI_API_KEY)", "Owner WhatsApp command channel not built — the command model is ready for it, the channel is shown as not connected"],
  doNotRetest: ["Owner control-room IA, Inbox story model, exact-terms approval card (f619e00)", "Commercial lifecycle, entitlements, value accounting (e8cd6b3)", "Train BARRY → effective runtime authority (cd6f741)", "Cart subject binding, checkout consent, F31 held approvals, tenant isolation, HQ founder auth (faf79a9, 49fe8d3)"],
  knownBlockers: [],
};
