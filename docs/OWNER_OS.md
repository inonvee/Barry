# Owner Business OS — capability map, IA and design-partner checklist

The Owner OS is a **productization layer** over systems that already exist. It decides nothing and enforces
nothing: the policy engine, founder controls, the initiative engine, the capability-readiness model, the
connection registry and the owner command service stay authoritative. `src/lib/owner/os.ts` (pure) and
`src/lib/owner/os-service.ts` (server, read-only, `/api/owner/os`) only restate what those systems hold, in
the owner's words.

WhatsApp is the primary command surface; the website is the visual OS. Both read and write the **same durable
records** (owner commands, operations, approvals, initiatives, learned facts) — there is no channel-local state.

## Phase 0 — capability map

Proof levels: **live** = proven on the deployed preview with real traffic; **deterministic** = proven by tests
against the real code paths (memory backend / scripted model); **simulated** = works end to end only on
BARRY's simulators (no real provider).

| Subsystem | What it does | Proof | Web surface | WhatsApp | Discoverable | Owner words | Daily / settings | Duplicates |
|---|---|---|---|---|---|---|---|---|
| Today / briefing | Story of the day: presence, needs you, working, just happened, money, noticed, ask | deterministic (renders from workspace); briefs live-proven | Today | daily brief, "What's happening?" | yes (home) | yes | daily | — |
| Ask BARRY | Owner command service: grounded reads, operations, decisions, rule requests | live (Owner WA) + deterministic | Ask BARRY (tab) + Today command bar | any message | yes (tab) | yes | daily | Today bar = same service (intentional) |
| Needs you (approvals + handoffs) | Intervention queue over real pending approvals / handoffs / failures | live (approve via WA) + deterministic | Work → Needs you; Today float | "Who needs me?", "approve …"/"decline …" | yes | yes | daily | was Actions & approvals → merged into Work |
| Operations | Owner-started bounded work on a customer class, grounded cohort, stop | deterministic; WA start live-proven | Work → BARRY is working; Today | "Recover abandoned checkouts", "Stop all follow-ups" | yes | yes | daily | — |
| Initiative engine + scheduler | Scans 3×/business-day; persisted, evidence-backed "BARRY noticed"; dedupe/fatigue | deterministic; cron scheduled (vercel.json) | Work → BARRY noticed (open + history); Today card | "What did you notice?" | yes | yes ("BARRY noticed") | daily | — |
| Abandoned checkout recovery | Proactive follow-up rule + owner operation | simulated (commerce on memory simulator for Rina) | Work, Money | "Recover abandoned checkouts" | yes | yes | daily | — |
| Unpaid / reminders | Follow-up rules (unpaid links, deposits, appointment reminders) | deterministic; customer send disabled | Work, Money → Unpaid follow-ups | "Follow up unpaid payment links" | yes | yes | daily | — |
| Value tracking (MADE / SAVED / AT RISK) | MADE = provider-verified only; SAVED = realised only; AT RISK; pending apart | deterministic | Money, Plan & billing | "How much did we make today?" | yes | yes | daily | — |
| Money in motion | Opportunities: whose move it is, at risk / waiting | deterministic | Money; Today strip | "Where is money stuck?" | yes | yes | daily | — |
| Conversations | Customer threads, story, outcomes, handoffs | live (customer WA dry-run/sim) | More → Customers (was Inbox) | customer name queries | yes | yes | daily | — |
| Business knowledge / Train BARRY | Genome + learned facts, sources, unsure, teach next | deterministic | More → What BARRY knows | — (teach on web) | yes | yes | settings | was Train BARRY → split into Knowledge + Setup |
| Rules (profile + owner-trained + founder) | Effective authority resolution + founder controls + follow-up rules, with provenance | deterministic (same resolution as policy engine) | More → Rules BARRY follows | rule messages → reviewed path | yes | yes | settings | discount rule was on Train page only |
| Connected systems | Connection registry + capability profiles; honest labels | deterministic | More → Connected systems | "What can you do?" | yes | yes | settings | was a panel in Settings → moved |
| Capability readiness | Needs → capabilities → provider → authority → setup steps | deterministic | More → BARRY setup (areas + unlock plan) | "What can you do?" | yes | yes | settings | — |
| WhatsApp linking | Owner identity link codes, revoke, rotation | live | Settings → WhatsApp | `LINK <code>` | yes | yes | settings | — |
| Owner controls / autonomy | Founder controls tighten only; owner levers = limits, approvals, stop | deterministic | BARRY setup → How autonomous is BARRY?; Rules (founder restrictions) | "Stop all follow-ups", approve/decline | yes | yes | settings | — |
| Plan / billing | Entitlements, free month, value proof | deterministic | More → Plan & billing (Settings#plan) | — | yes | yes | settings | — |
| Activity / audit | Outcomes, decisions, follow-ups, owner commands (any channel), noticed | deterministic | More → Activity | — | yes | yes | both | Today "Just happened" = first 7 |
| Readiness / launch | Pilot readiness (server-assessed), launch checklist (HQ) | deterministic | More → BARRY setup | — | yes | yes ("ready to start supervised") | settings | HQ launch checklist (founder side) |

## Information architecture

Daily: **Today · Ask BARRY · Work · Money** (phone bottom bar: the same four + More).
More (the OS): **Customers · Rules BARRY follows · What BARRY knows · Connected systems · Activity · BARRY setup ·
Plan & billing · Settings**.

Older links keep working: `?tab=inbox` → Customers, `?tab=actions` → Work, `/owner/train` → BARRY setup,
`/owner/train?rule=…` → Rules BARRY follows (teach a rule). WhatsApp deep links (`?intervention=`,
`?operation=`, `?conversation=`) still scroll to their record.

## Owner-language mapping

| Internal | Owner sees |
|---|---|
| initiatives | BARRY noticed |
| approvals / handoffs | Needs you |
| operations / follow-up rules | BARRY is working |
| policy / authority / founder controls | Rules BARRY follows (sources: Built into BARRY · Default — your business profile · Taught by you · Restriction from the BARRY team) |
| genome / learned facts | What BARRY knows |
| integration fabric | Connected systems (REAL · SIMULATED · READ-ONLY · SUPERVISED · TEST MODE · UNAVAILABLE · NOT CONNECTED) |
| audit | Activity |
| readiness | BARRY setup ("Ready to start supervised" / "N things left before a supervised start") |
| controls / mode | How autonomous is BARRY? (Practice · Supervised · On its own, within your rules) |

## Honesty rules the OS keeps

- A simulator is always **SIMULATED**, whatever the mode; nothing reads REAL without a connected real provider.
- A rule's source is the provenance the runtime recorded; an unconfirmed learned rule is shown as *not used*.
- Temporary rules, per-customer limits and owner-edited follow-up timing are listed as **not supported yet**.
- Readiness level is the server's assessment; every blocker says who acts (you / a connection / the BARRY team /
  optional) and links to where it is resolved. Customer-traffic release requirements are the BARRY team's and
  are shown apart.
- "BARRY noticed" money is *at risk / could be recovered (not revenue)*; only a measured, provider-verified result
  is called verified.
- Reading the OS sends nothing and writes nothing (tested).

## Phase 17 — design-partner checklist (Rina Studio)

| Status | What | Why | Where | Proof |
|---|---|---|---|---|
| SOFTWARE READY | Owner OS (Today/Ask/Work/Money + OS pages), shared WA/web state | productization pass | `/owner…` | `__tests__/owner-os.test.ts`, qa-acceptance render test, mobile screenshots |
| SOFTWARE READY | Owner WhatsApp command channel, briefs, approvals | live-proven earlier | WhatsApp | live gate (earlier passes) |
| SOFTWARE READY | Initiative scheduler (3 scans/day) | BARRY noticed stays fresh | cron `/api/cron/initiative-scan` | initiative-scheduler tests |
| EXTERNAL CONNECTION | Real commerce + payments for Rina (today: memory simulator, no `business_connections`) | nothing real happens on a simulator | Connected systems | Supabase: no rows in `business_connections` for Rina |
| EXTERNAL CONNECTION | Customer WhatsApp number routed to Rina | customers must reach BARRY | Connected systems → WhatsApp — your customers | readiness `channel.configured` |
| OWNER INPUT | Handoff path, refunds rule, contact details | BARRY must answer honestly / hand off | What BARRY knows → Teach | readiness `handoff.path`, `knowledge.*` |
| OWNER INPUT | Approved learning sources (website / documents) | BARRY knows only what is approved | What BARRY knows → Sources | Learn Business sources empty |
| FOUNDER ACTION | Set Rina's mode to **supervised** once the above pass | supervised start | HQ → business controls | founder control audit entry |
| INTENTIONALLY DISABLED | Live customer follow-up sending (`BARRY_WHATSAPP_SEND` stays dry-run) | no real customer sends until supervised start is approved | env | Systems shows TEST MODE |
| INTENTIONALLY DISABLED | Real financial actions | no real money without a real provider and supervised start | — | payments label SIMULATED |
