# Preview operationalization and live-channel acceptance

Production (Supabase `ynnmlsnmybbaxeyolydj`) is never touched by anything here. The Preview deployment must use the
Preview branch database (`glqrfoljvdbyrmbvupym`), which has migrations 0019 + 0020; Production has neither.

## 1. Vercel — Preview environment only

Set these for the **Preview** environment (Project → Settings → Environment Variables → uncheck Production and
Development). Leave every Production value as it is.

| Variable | Preview value |
|---|---|
| `SUPABASE_URL` | `https://glqrfoljvdbyrmbvupym.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the Preview **branch's** service-role key (Supabase → branch `barry-preview` → API) |
| `CRON_SECRET` | a new random value, ≥ 32 chars (`openssl rand -hex 32`) — Preview only |
| `BARRY_FOUNDER_TOKEN` / `BARRY_OWNER_TOKEN` (or `BARRY_OWNER_TOKENS`) | Preview-only values (founder ≥ 32 chars, different from owner) |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN` | the existing WhatsApp **test** app |
| `BARRY_WHATSAPP_ROUTES` | Preview test route: `1315221915012159=fashion-retailer` |
| `BARRY_WHATSAPP_SEND` | `dry_run` for the first pass; `live` only to reach your own test recipient |
| `BARRY_REASONER=openai`, `OPENAI_API_KEY` | as today (the approval flow needs the live model) |

Then redeploy the Preview branch. Check isolation without secrets: `GET <preview>/api/qa/status` must show
`environment: "preview"`, `databaseProject: "glqrfoljvdbyrmbvupym"` and `cron: "secret configured"`; the same route on
Production returns 404, and Production's own `SUPABASE_URL` must still be `ynnmlsnmybbaxeyolydj`.

Vercel Cron only fires on Production deployments; on Preview the runner below calls `/api/cron/background` itself.

## 2. Run the acceptance against the deployed Preview

```
BARRY_PREVIEW_URL=https://<preview>.vercel.app BARRY_EXPECT_DB=glqrfoljvdbyrmbvupym \
BARRY_BUSINESS_ID=fashion-retailer WHATSAPP_PHONE_NUMBER_ID=<test pnid> WHATSAPP_APP_SECRET=... \
BARRY_OWNER_TOKEN=... BARRY_FOUNDER_TOKEN=... CRON_SECRET=... [VERCEL_BYPASS=...] \
node scripts/acceptance/preview-live.mjs
```

It refuses to run unless the deployment reports a non-production environment on the Preview database. It uses one
synthetic customer number (set `BARRY_TEST_CUSTOMER` to your own number if sending is live), signs webhooks like Meta,
re-delivers non-2xx like Meta, and checks: inbound, reply, truthful sent/dry-run, persistence, duplicate ids, a rapid
burst, take-over / held message / owner reply (retried) / give back, SUPERVISED + approval, pause / resume, cron auth,
one run per slot, mode respected by scheduled work — then restores the business to SIMULATOR. Evidence is written to
`scripts/acceptance/preview-evidence-<run>.json`; verify the stored rows for the printed conversation id in the Preview DB.

## 3. SUPERVISED — what runs on its own vs. what needs the owner

Source of truth: `src/lib/runtime/action-risk.ts` (applied in `applyFounderControls`). Only ever tightens the
business's own rules.

**Autonomous (reversible, low-risk), still subject to the business's own rules**
- reads: product search, availability, inventory, payment verification, every `read` capability
- `addToCart`, `updateCartLine` / `commerce.cart.create`, `commerce.cart.update` — a cart is a draft, no money moves
- `support.ticket.create` — opens a case for the team
- conversational replies, handoff to a person, recording the customer's details

**Owner approval required**
- `createCommerceCheckout` (checkout + payment link), `createPaymentRequest` — money
- `createCommerceOrder` — a commitment
- `createBooking` — booking confirmation
- `payments.refund`, `shipping.shipment.create`, `messaging.send` (outbound through a capability)
- any request carrying a price / discount / amount / override (a policy exception)
- any consequential capability not on the autonomous list, including ones added later (fail safe)
- proactive follow-ups (sent only when the owner runs them)

## 4. Preview environment refresh

Current Preview acceptance route is configured for `1315221915012159=fashion-retailer`, with WhatsApp sending forced to `dry_run` for the first deployed gate.

Preview database credentials are intentionally isolated from Production. After changing Preview-scoped Vercel environment variables, trigger a fresh Preview deployment before running the acceptance gate so the deployment picks up the new values.

## 5. In-deployment runner (no secrets leave the Preview)

`POST /api/qa/acceptance` runs the same checks **inside** the Preview deployment, through the real route handlers,
with the deployment's own WhatsApp app secret, owner / founder tokens and CRON_SECRET. Founder-authenticated
(`Authorization: Bearer <BARRY_FOUNDER_TOKEN>` or an HQ session). It exists only when `VERCEL_ENV=preview`, the
database is `glqrfoljvdbyrmbvupym` and `BARRY_WHATSAPP_SEND=dry_run` — otherwise 404 (Production included).

- `POST {}` → every stage (channel, handoff, supervised, mode, cron); `POST {"stages":["channel"]}` → a subset
  (use stages if a full run would exceed the function's time limit).
- 200 = PASS, 422 = FAIL; the body is the report (`runId`, per-check PASS/FAIL, deployment facts, conversation ids).
- `GET ?runId=qa-…` → the stored report (operator record `qa_acceptance:<runId>` on business `fashion-retailer`).
- `POST {"cleanup":"qa-…"}` → deletes that run's synthetic conversations (customer numbers `999…`); the report stays.
- Temporary: remove `src/app/api/qa/acceptance/` once the gate has passed.

## 6. Owner WhatsApp V1 acceptance (in-deployment)

`POST /api/qa/owner-whatsapp` (or the page `/hq/qa/owner-whatsapp`) — the same guards as section 5 (Preview on the
Preview database with dry-run sending, else 404; founder bearer token or HQ session; one acceptance run at a time).
Stages: `identity`, `reads`, `decisions`, `conversation`, `mode`, `notifications` (`POST {"stages":[…]}` for a subset).

- Customers write through the real signed webhook route (synthetic `9997…` numbers). The owner writes through the
  real owner gateway with a synthetic `9999…` number linked by a one-time code for the run and revoked at the end;
  the owner line's replies are dry run (or recorded as blocked when no owner line is configured) — nothing is sent.
- It checks: verified owner vs unknown phone; owner/customer path separation; Hebrew + English reads (needs me,
  handling, waiting on, money today / stuck / awaiting / failed against the records); ambiguous "approve" asks;
  unrelated requests clear context; explain → "yes" approves the request in context (live model reached checkout
  under SUPERVISED); duplicate owner message id runs once; Hebrew decline; take over → customer held → draft →
  "send it" (dry run) → no double send → give back; Hebrew pause → customer stored not answered → mode → resume;
  founder pause not overridable; notification once, never twice, never sent; audit (command records, controls
  audit, control log). Controls are restored afterwards.
- `GET ?runId=owa-…` → stored report (`qa_owner_whatsapp:<runId>`); `POST {"cleanup":"owa-…"}` → deletes the
  run's synthetic conversations. Temporary: remove `src/app/api/qa/owner-whatsapp/` and `src/app/hq/qa/owner-whatsapp/`.

### One click, one stage per request, safe restore

- `/hq/qa/owner-whatsapp` → **Run full Owner WhatsApp acceptance** runs `identity → reads → decisions → conversation →
  mode → notifications`, each as its own `POST {"stages":[…]}` (each fits Vercel's 300s limit), one after another,
  with live progress, each stage's runId and report kept, all checks aggregated into one verdict. It stops at the
  first FAIL / TIMEOUT / ERROR and shows the failing checks.
- Restore point (`src/lib/qa/restore-point.ts`, both QA runners): before changing anything a run records the test
  business's original mode + pause state once (`founder_state` / `qa_restore_point`). Every stage restores from it
  (original controls, every synthetic `999…` owner link revoked, point cleared). A stage stops itself at a 230s
  budget; the route answers by 280s (restoring first) if a step hangs; the acceptance lock lease is 300s. A run that
  is killed anyway leaves the point in place: the next run recovers from it first, and `POST {"restore":true}`
  (called by the page before and after every run, retrying while a killed stage's lock expires) applies it.
  `GET ?state=1` shows the business's current controls and any pending restore point.

## 7. Founder WhatsApp V1

- Founder line: `BARRY_WHATSAPP_FOUNDER_NUMBERS` (phone_number_ids, Preview-scoped) — distinct from customer routes and
  owner lines (a number configured as either is ignored as a founder line).
- Founder send mode: `BARRY_WHATSAPP_FOUNDER_SEND=live` (Preview only) makes ONLY founder replies / founder notices
  live; customer and owner lines keep `BARRY_WHATSAPP_SEND=dry_run`. Anything but exactly `live` is dry run. The three
  modes are logged at startup and shown in `GET /api/qa/status` (`whatsappSendModes`) and on `/hq/founder-whatsapp`.
  The founder line answers ONLY verified founders: an unknown sender (or a wrong link code) gets no reply at all. Optional `BARRY_FOUNDER_TIMEZONE` for the daily founder brief window (default UTC).
- Linking: `/hq/founder-whatsapp` (HQ founder session) → "Get a link code" → send `LINK <code>` from the phone to the
  founder line. Founder links are bound to `BARRY_FOUNDER_TOKEN` (rotation ends them) and revocable there.
- Acceptance: `/hq/qa/founder-whatsapp` → one click runs `identity → reads → context → mutations → notifications`, one
  POST to `/api/qa/founder-whatsapp` per stage, same guards / restore point / time budget as section 6. Founder controls
  touch only the test business; every lever (mode, pause, approval-for-all, paused capabilities, safe mode) is
  restored, and synthetic 999… founder / owner identities are revoked after every stage. Reports:
  `qa_founder_whatsapp:<runId>`. Temporary: remove `src/app/api/qa/founder-whatsapp/` and `src/app/hq/qa/founder-whatsapp/`.

### Single WhatsApp number for every role

`BARRY_WHATSAPP_ROLE_ROUTING=identity` (Preview): on BARRY's routed number(s) the VERIFIED SENDER decides — an active
founder link (or a valid HQ founder `LINK` code) → Founder BARRY; an active owner link of that line's business (or a
valid owner code for it) → Owner BARRY; everyone else → the customer flow. Never inferred from message text; a wrong /
expired code is an ordinary customer message; a revoked founder falls back at once. No `BARRY_WHATSAPP_FOUNDER_NUMBERS`
is needed. Each role keeps its own send mode (founder: `BARRY_WHATSAPP_FOUNDER_SEND`; owner / customer:
`BARRY_WHATSAPP_SEND`), chosen by the gateway, never by the receiving number. Founder proactive notices go back from
the line the founder last wrote to. Deployed acceptance: stage `shared_line` of `/hq/qa/founder-whatsapp` (real signed
webhook on the routed number; every role's sender is a recording dry sender for the stage — nothing is sent).
