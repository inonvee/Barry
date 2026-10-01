import type { AcceptanceManifest } from "./manifest";

/**
 * THE ACCEPTANCE MANIFEST for the current candidate — authored with each build pass from what changed
 * and how it was proven. Deterministic and local proof are the build lane's; live proof is Work's.
 * Keep it compact: Work should enter a pass knowing the few things that really need live proof.
 */
export const ACCEPTANCE_MANIFEST: AcceptanceManifest = {
  candidate: "Owner control room: dark visual system, Today / Inbox / Money / Ask BARRY / More information architecture, live work + activity from recorded state, rule → BARRY → verified result flows, WhatsApp-first framing (truthfully not connected yet)",
  domainsChanged: ["owner UI (design tokens scoped to .barry-owner, owner kit primitives, OwnerShell sidebar + mobile tab bar, Today / Inbox / Money / Ask / Actions views, Train BARRY, Settings)", "owner read model (channels: customer WhatsApp routing state + owner command channel; /api/owner/channels)", "control-room read model (now working, activity feed, workflows, activity by hour — pure, from obligations / outcomes / approvals)"],
  riskAreas: ["no number or line on the owner surfaces may be invented — only recorded obligations, outcomes, approvals and verified payments", "recovered money only = provider-verified payment after a BARRY follow-up; test money never counts as made", "the owner WhatsApp command channel must never read as connected (it is not built)", "HQ must render unchanged (owner tokens default light outside .barry-owner)"],
  implemented: [
    "Owner design language: --o-* tokens (deep navy, blue / violet accent, green only for verified / live, amber / red only operational), panels, glow, live dots, orb, shimmer skeletons; reduced motion respected",
    "Owner kit: Icon set, IconTile, Orb, LiveDot, Panel, PanelHeader, BigMetric, Bars, ShareBar, Flow (command → BARRY works → verified result), ActivityRow, Segmented, Hero",
    "OwnerShell: sidebar (Today, Inbox, Money, Ask BARRY; More: Actions & approvals, Train BARRY, Connections, Plan, Settings), presence chip, WhatsApp card, 5-tab mobile bar + More sheet",
    "Today: needs-you count, handled / made / at risk, BARRY is working (open obligations) + live feed, what BARRY did, rules → results flows, money in motion",
    "Inbox: five states (BARRY handling, waiting on customer, waiting on you, needs review, resolved) + conversation story (wanted → did → stands → next), technical detail behind a toggle",
    "Money: made / recovered / pending / at risk / saved (plan-gated), margins ladder, recovery flows, every amount explained, test money labelled",
    "Ask BARRY (answers with links to decide / open / unlock; capabilities now), Actions & approvals (exact terms humanised, why, then, evidence), Train BARRY (rules / knows / unsure / sources; ACTIVE / NEEDS REVIEW / UNDERSTOOD ONLY / REPLACED / BLOCKED), Settings (business & access, plan + value, connected systems)",
  ],
  deterministicallyProven: [
    "owner-control-room (6): workflow math (eligible / contacted / open / excluded / closed; recovered only verified-paid after follow-up; test items apart); now-working lines; empty business shows nothing; five conversation states; Today / Money / Actions render from a real workspace; WhatsApp owner commands shown as not connected",
    "previous suites unchanged and green (owner OS, value accounting, commercial operability, train-to-runtime authority, founder control plane)",
  ],
  locallyProven: ["Local dev server (memory store, seeded QA scenarios): /owner Today, Inbox, one conversation (Rina discount approval), Money, Ask BARRY, Actions & approvals, Train BARRY and Settings captured at 1440px and 390px — 0px horizontal overflow on all 16; exact terms read 'Discount 10% · Item … · List price ₪420'"],
  liveProofRequired: [
    { id: "today_live_truth", title: "Today on Rina: needs-you count matches Actions; 'BARRY is working' lines and the activity feed match the open obligations and recent records; nothing shown for an empty business", why: "Control-room read model on Supabase data", where: "/owner (Rina)", risk: "high" },
    { id: "approval_benchmark", title: "Discount approval from Actions on mobile: exact terms, why, then; approve → customer checkout priced once; decline → nothing sent or charged", why: "Redesigned InterventionCard over the unchanged approval endpoints", where: "/owner?tab=actions at 390px, /simulator", risk: "high" },
    { id: "recovery_flow", title: "Unpaid follow-up flow: a real follow-up then a provider-verified payment → 'Paid (verified)' and Recovered on Money; a simulated payment stays test money", why: "Recovered = verified after follow-up only", where: "/owner Today + Money", risk: "high" },
    { id: "inbox_states", title: "Inbox states on real conversations: waiting on you / on customer / needs review / resolved filters and the story panel match the conversation trace", why: "State mapping on live data", where: "/owner?tab=inbox", risk: "medium" },
    { id: "whatsapp_framing", title: "WhatsApp card: owner commands 'not connected yet'; customer WhatsApp line matches the Preview routing (live / dry run / not routed / not set up)", why: "Real channel config on Preview", where: "/owner, /owner/settings", risk: "medium" },
    { id: "hq_unchanged", title: "HQ renders as before (light), HQ Commercial founder flow still works", why: "Shared CSS / primitives touched", where: "/hq, /hq/commercial", risk: "medium" },
  ],
  knownUnverified: ["Preview deployment unreachable from the build environment; live model answers in Ask BARRY unverified (no OPENAI_API_KEY)", "Owner WhatsApp command channel not built (shown as not connected)"],
  doNotRetest: ["Commercial lifecycle, entitlements, cost ledger, value accounting (e8cd6b3)", "Train BARRY → effective runtime authority and pre-cart discount (cd6f741)", "Named cart subject binding, checkout consent, F31 held approvals, tenant isolation, HQ founder auth (faf79a9, 49fe8d3)"],
  knownBlockers: [],
};
