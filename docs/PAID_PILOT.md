# Paid pilot: owner product, revenue, channels, handoff, readiness

This document is the single reference for what a first paying design partner gets, how each part is
derived, and what still blocks the pilot. Status words: **built** (implemented and tested
deterministically), **scaffolded** (interface and checks exist, not proven against the real external
service), **not built**.

## 1. Owner product model (`/owner`, `/owner/train`) — built

The owner sees their business, not BARRY's machinery. There are no capability ids, traces, ledger
entries or provider names by default. Technical detail per conversation is opt-in.

**Read model:** `src/lib/owner/service.ts` (`getOwnerWorkspace`). It is tenant-scoped, one business per
call, and built from authoritative records only:
- conversation state and its effect ledger;
- owner requests with their lifecycle;
- provider-verified payments;
- confirmed bookings;
- orders;
- handoffs;
- turn traces, used for AI health.

A source that fails to load is listed as unavailable, never zeroed.

| Tab | What it shows |
|---|---|
| **Today** | The rest of the dashboard follows a time window, set in the business's own timezone. Today shows: conversations, how many BARRY handled without the owner, what needs the owner now, completed outcomes, blocked/failed, money (§2), conversion, and the owner-intervention rate. |
| **Inbox** | Every conversation with its customer, channel, status (needs you / in progress / waiting on customer / completed / lost), the reason it needs the owner, and outcomes. The detail view shows messages, where the transaction stands, requests and handoffs, plus optional technical detail. |
| **Approvals** | Each request shows what the customer wants, the exact action, money and terms, why approval is required, its lifecycle and revision, and whether newer customer context changed anything. **A held request is never actionable**: Approve is not offered, Decline and "Re-check conversation" are. Approve goes through the full resume path (§6). |
| **Outcomes** | Paid, booked, order created, case created, checkout not completed, blocked, failed, handoff, declined by the owner. Each outcome shows the record that proves it. |
| **Health** | AI health is taken from recorded traces. It covers working, degraded, unavailable (e.g. *"the AI provider account is out of credit"*), simulator, or no traffic, with the last failure's classification (kind, HTTP status, provider code). It also shows connected systems (healthy / simulated / degraded / disconnected / not set up, last verified, missing settings by name) and handoffs, which can be resolved. |
| **Ask BARRY** | Owner Barry (§7). |

**Access:**
- `BARRY_OWNER_TOKENS=businessId:token,…` gives each owner a token that opens **only** their business.
- `BARRY_OWNER_TOKEN` remains the operator token for all businesses.
- In production at least one must be set.
- Every owner API checks that the requested record belongs to the business. Another tenant's approval returns "not found".

## 2. Revenue attribution (`src/lib/owner/revenue.ts`) — built

Money is reported in categories that are **never added together**, and always per currency:

| Category | Counts | Never counts |
|---|---|---|
| **Collected by BARRY** (direct) | A payment request BARRY created that the provider reported **paid and verified** (`status=paid` + `verifiedAt`) | A payment link sent, a customer saying "I paid", an owner approval, a "paid" status without verification |
| **Recovered** (subset of direct) | Paid after an earlier failed or cancelled payment, or a blocked write, in the same conversation | — |
| **Booked, not yet collected** (influenced) | Offer price of a confirmed booking BARRY made, minus what BARRY collected for it | Offers without a price |
| **Open opportunities** (potential) | Unpaid payment links (< 24h) and payment requests waiting on the owner | — it is never revenue |
| **Test/simulated** | Payments and bookings on simulated providers | — never in the categories above |

Also tracked:
- conversations reaching purchase intent, and how many converted;
- lost opportunities (withdrawn, declined, payment failed or cancelled, link unpaid after 24h);
- discounts granted and refused;
- owner interventions.

**Not tracked (no evidence source yet):**
- upsell/cross-sell attribution;
- recovered abandoned *conversations* (as opposed to recovered payments).

## 3. Handoff (`src/lib/runtime/handoff.ts`) — built

- **Trigger:**
  - the model signals `handoffRequested` + reason + urgency (the customer wants a person, or needs something only a person can resolve);
  - two consecutive understanding failures also hand off.
- **What is recorded:** the runtime records one open handoff per conversation, with:
  - trigger, reason, urgency;
  - a deterministic context summary (customer, why, latest messages);
  - unresolved asks;
  - the transaction snapshot.
- **What the customer may be told:**
  - BARRY may say the team will get back to them **only if** the business declared how its team responds (Genome `playbook.handoff`).
  - Otherwise the reply says the team can see the conversation but BARRY can't promise when or how they'll reply.
  - Claim grounding enforces this: a callback claim needs a `handoff.created` effect with a declared response path.
- **Owner side:** the handoff appears in the owner's inbox and Health tab, and can be resolved there.
- **Not built:** replying to the customer from the dashboard. The team replies in its own channel today.

## 4. Channel gateway + WhatsApp (`src/lib/channels/`) — scaffolded

`gateway.ts` is channel-agnostic. It:
- maps a channel user to one conversation per business;
- processes each message **at most once**: the message id is marked seen *before* the runtime runs, so a provider retry can never repeat a consequential action;
- renders replies (text, products, payment links) for text channels;
- records delivery for each reply (sent / dry_run / failed).

`whatsapp.ts` + `POST/GET /api/channels/whatsapp` implement the Meta WhatsApp Cloud API:
- the subscription handshake;
- an `X-Hub-Signature-256` HMAC check over the raw body (unsigned or invalid → 401 before parsing);
- phone-number → business routing;
- text normalization (unsupported types and unrouted numbers are reported, not processed);
- a Graph API sender.

**Replies are dry-run unless `BARRY_WHATSAPP_SEND=live`.**

**Configuration** (names only; nothing configured in this environment):
- `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`;
- `BARRY_WHATSAPP_ROUTES=<phone_number_id>=<businessId>`;
- `BARRY_WHATSAPP_SEND`.

**Not proven:** a real Meta webhook delivery and a real sent message. No credentials were available.

**Not built:**
- media messages;
- status callbacks written back to delivery records (they are only logged);
- the 24h-window / template-message rules;
- Instagram and hosted web chat.

## 5. Train BARRY + pilot readiness (`src/lib/owner/training.ts`, `readiness.ts`) — built

The assisted onboarding view has eight sections, all derived from what the runtime uses:
1. identity;
2. goals;
3. offers, knowledge and policies;
4. systems;
5. what BARRY can do (read / on its own / within limits / with approval / never);
6. owner authority;
7. personality and playbook;
8. the readiness test.

Each section lists what is missing. Editing is done in the Genome with the founder (assisted); self-serve editing is **not built**.

Readiness is **one level**, reached only when every check for that level and below passes. Warnings never block.

| Level | Requires |
|---|---|
| Not ready | — |
| Ready for testing | Offers and goals |
| Ready for a supervised pilot | Everything above, plus: <ul><li>a live AI model;</li><li>AI available;</li><li>durable storage (Supabase);</li><li>owner access;</li><li>the knowledge requirements the Genome doesn't already state;</li><li>real providers for every system BARRY uses (no simulators);</li><li>a WhatsApp number routed to the business;</li><li>a declared handoff path.</li></ul> |
| Ready for customer traffic | Everything above, plus: <ul><li>live sending;</li><li>a real WhatsApp message received and answered;</li><li>a real payment verified end to end (if the business takes payments);</li><li>AI healthy under traffic.</li></ul> |

Every failing check says what is missing and how to fix it. The founder view (HQ) shows the same level.

## 6. Correctness under failure (see DOMAIN_TRUTH.md)

- **Stale approval:** a pending request is **held**, never executed, while a later customer message is unverified: it couldn't be understood, or it names a near-miss of the request's own reference.
- **Revalidation:** once understanding is available, the unresolved message is re-understood in its own context. This happens at the next customer turn, at the owner's Approve, or on "Re-check conversation".
  - If the message changed or withdrew the request, the stale request is superseded or withdrawn and the customer is told.
  - If it didn't, the hold is released.
- **Provider/model failure:** the failure is first-class state:
  - the Inspector and Health show its classification;
  - nothing is executed;
  - the customer gets a safe "couldn't process — nothing changed" reply (no provider details);
  - a repeated failure hands off.
- **Multi-intent:** the IR lists each ask. Remaining change asks are continued (bounded, grounded, authorized), and anything not done is said to be not done.
- **Business facts:** the composer sees fact provenance. Hours, times, measurements and policies not in the Genome, a provider read, or the customer's own words are rejected from replies.

## 7. Owner Barry (`src/lib/owner/ask.ts`) — built (read-only MVP)

Owner Barry answers the owner's questions ("What happened today?", "Who needs me?", "How much did you collect this week?", "Which opportunities did we lose?") from one briefing. The briefing comes from the same read model as the dashboard: today, 7-day revenue by category, what waits for the owner, conversations needing attention, recent outcomes, AI and system health, and readiness.

- **No write path:** it has no tools. A request to act gets an explanation of where the owner does it.
- **Every answer is checked:**
  - every figure must appear in the briefing;
  - no claim of having done something is allowed.
- **Fallback:** without a model, or when a check fails, the owner gets the factual briefing text instead.

Future mutations ("change my discount limit") must become structured proposals through the authority system. That is **not built**.

## 8. Founder HQ — aligned

Each business card in `/hq` now also shows, from the same read models:
- pilot readiness;
- AI health over 7 days (with the last failure's classification);
- verified revenue over 7 days (simulated money shown apart, not counted);
- conversations, approvals and handoffs needing intervention;
- lost opportunities.

Founder Barry (conversational HQ) is **not built**.

## 9. Remaining blockers before the first paying design partner

1. **No live model verification of this pass.** The model-dependent parts have only been tested deterministically, with scripted model outputs:
   - the ask list and continuation;
   - handoff signals;
   - revalidation re-understanding;
   - Owner Barry answers.

   They need focused live runs on the configured reasoner.
2. **WhatsApp is not connected.** It needs a Meta app, a WhatsApp Business number, webhook registration pointing at the Preview/production URL, and the variables above. Then comes a supervised dry-run period, then live sending.
3. **A real payment provider and a real verified payment for the partner.** Revenue can't be shown otherwise; simulated money is excluded by design.
4. **Durable storage and per-owner access in the pilot environment:** Supabase and `BARRY_OWNER_TOKENS`.
5. **The partner's Genome:**
   - offers, knowledge and policies;
   - a handoff path;
   - authority limits;
   - entered with the founder, with no self-serve editing yet.
6. **Owner replies to handed-off customers** are not possible from the dashboard.
7. **Scale.** The owner read model loads the business's full conversation states. That is fine for a pilot, not for large volumes: it needs aggregate queries later.

## 10. QA on Preview (testing cockpit)

Every testing surface shares one navigation and status strip:
- **Surfaces:** Customer simulator, Owner, Train BARRY, Connections, Learn business, QA tools, HQ.
- **Status strip:** the current business, environment, AI health, model, storage, owner access, WhatsApp, payments and build SHA. Status comes from `/api/qa/status`, which contains no secrets and is 404 on Vercel Production.

**Owner access (one-time Preview setup, done by someone with Vercel access):**
- Set the variable below for the **Preview** environment only, then redeploy.
- Use one random token per business, at least 16 characters; `openssl rand -hex 24` generates one.
- Never reuse the founder token.
- Keep the tokens out of the repo and share them with testers privately.

```
BARRY_OWNER_TOKENS=fashion-retailer:<token-A>,barry-logistics-demo:<token-B>,spa:<token-C>
```

**Signing in:**
- Owner → select the business → paste its token → **Sign in**. This sets a 12-hour httpOnly session for that business only; the token is never stored or shown by the page.
- Switching to another business shows "signed in to a different business" until you sign in with that business's token.
- Signing in with another business's token is refused.
- **Sign out** clears the session.

**QA mode:**
- On Vercel Preview and in development, QA tools are on (`BARRY_QA_MODE=0` turns them off).
- On Vercel Production they never exist: the gate is hard-off and the routes return 404.
- Every QA action needs the owner session for that business.

**Recipes:**
- **Forced understanding failure (F31 fail-closed branch):**
  1. In the simulator (Logistics), create a support case that needs approval.
  2. In QA tools, arm "fail next message". The conversation id defaults to the simulator's current one.
  3. Send the correction in the simulator. The Inspector shows `qa_forced_understanding_failure`, and Owner → Approvals shows the request **HELD** with no Approve button.
  4. Press **Re-check conversation**. The correction is applied (the old request becomes SUPERSEDED) or, if unrelated, the hold is released.
- **WhatsApp dry run:** QA tools → Simulate inbound WhatsApp.
  - It builds a real Cloud API payload and runs it through the real adapter and gateway.
  - **Replay same message id** shows DUPLICATE: the message is processed once.
  - The reply is recorded as `dry_run` and nothing is sent to Meta.
  - This does not replace a real Meta end-to-end test.
- **Tenant isolation:** sign in with Rina's token and select Logistics. Everything is refused, including Owner APIs, Ask BARRY, readiness and simulator approvals.
- **Handoff:** in the simulator, ask for a person. In Owner → Health → Handoffs it appears OPEN; **Acknowledge**, then **Mark resolved**. BARRY never replies on the team's behalf.
- **Revenue:** Owner → Today → "Why these numbers" lists every amount, its category (COLLECTED / RECOVERED / BOOKED, NOT COLLECTED / OPEN OPPORTUNITIES / SIMULATED / NOT COUNTED) and the record that proves it.
- **Live proof** (needs `OPENAI_API_KEY`): `npm run eval:pilot`.
