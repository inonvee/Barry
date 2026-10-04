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
| `BARRY_WHATSAPP_ROUTES` | `<test phone_number_id>=<test business id>` (e.g. `fashion-retailer`) |
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

Preview database credentials are intentionally isolated from Production. After changing Preview-scoped Vercel environment variables, trigger a fresh Preview deployment before running the acceptance gate so the deployment picks up the new values.
