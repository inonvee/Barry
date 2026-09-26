# Deployment

BARRY is deployed on Vercel, connected to this GitHub repo — every push to
`claude/barry-core-phase-1-3xfqaf` redeploys automatically, no manual step
needed. As of Phase 1.5, real persistence and an optional LLM reasoner are
wired in behind env vars; with none set, BARRY still runs fully on the
deterministic MockReasoner and an in-memory backend (see `.env.example`).

## Environment variables to add in Vercel (Phase 1.5)

Project Settings → Environment Variables, for the environments you want
(Preview and/or Production):

| Variable | Value | Required for |
|---|---|---|
| `SUPABASE_URL` | `https://ynnmlsnmybbaxeyolydj.supabase.co` | Persistent conversations/bookings/approvals surviving serverless cold starts |
| `SUPABASE_SERVICE_ROLE_KEY` | *(Supabase dashboard → Barry project → Settings → API → service_role key)* | same |
| `OPENAI_API_KEY` | *(your OpenAI key)* | LLM-backed natural conversation |
| `BARRY_REASONER` | `openai` | switches from MockReasoner to OpenAIReasoner (needs `OPENAI_API_KEY` too) |
| `BARRY_MODEL` | e.g. `gpt-4o-mini` | optional, defaults to `gpt-4o-mini` |

`SUPABASE_SERVICE_ROLE_KEY` and `OPENAI_API_KEY` are server-only secrets —
they're read only in API route handlers and the runtime, never in a
`"use client"` component, so they never reach the browser bundle.

Without `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` set, BARRY keeps using
the in-memory backend (fine for a quick demo, but state resets on cold
start — see below). Without `OPENAI_API_KEY` + `BARRY_REASONER=openai`,
BARRY keeps using MockReasoner (deterministic, English-only, no natural
free-form conversation).

## The Supabase project

Project **Barry** (`ynnmlsnmybbaxeyolydj`, `eu-central-1`/Frankfurt), org
`hkopatkurnfadlzojjkr`. Migration `supabase/migrations/0001_barry_core.sql`
is already applied: `conversations`, `messages`, `turn_logs`, `bookings`,
`payment_requests`, `approvals`, `follow_ups`, `inventory_adjustments`.
Every table has RLS enabled with **no policies** — only the service-role
key (server-side) can read or write; there is no anon/authenticated
browser access to this data at all.

## One-time Vercel setup (if starting fresh)

1. https://vercel.com/new → import the repo → Next.js preset auto-detected.
2. Add the env vars above (optional — see table).
3. Deploy. Root `/` redirects to `/simulator`, which is mobile-first.

## What to test from your phone once deployed

With Supabase + OpenAI env vars set:

1. Open `/simulator`, pick **Serenity Massage Spa**.
2. Try the natural conversation from the brief:
   `"Hey"` → `"Do you guys have anything Sunday around 1?"` → `"For couples"`
   → `"90 minutes if possible"` → `"How much?"` → `"Okay let's do it"`.
3. Check the Inspector tab shows **Reasoner: LLM** on each turn.
4. Confirm BARRY asks only for what's still missing (not name/phone before
   they're relevant), calls `checkAvailability`, then `createPaymentRequest`.
5. Use the chat's "Mark paid" control to simulate payment success — BARRY
   should create the booking and confirm, with no further input from you.
6. **Refresh the page** (or reopen the URL later) — the conversation should
   still be there. This only works with Supabase configured; without it,
   a cold serverless start can lose in-memory state.
7. Try a Hebrew message (e.g. "שלום, אני רוצה לקבוע עיסוי ליום ראשון בשעה אחת")
   and confirm BARRY replies in Hebrew.
8. Try requesting a large discount (e.g. "can I get 20% off?") — it should
   go to the Approvals tab instead of executing automatically.

Without those env vars set, the same flows work through MockReasoner
(English only, deterministic) and in-memory state (resets on cold start) —
useful for a quick check, but not what proves Phase 1.5's actual goal.

## Known limitations

- **In-memory fallback state**: only active when Supabase env vars are
  unset. With them set, conversations, bookings, payments, and approvals
  are fully persisted in Postgres and survive across requests/cold starts.
- **MockReasoner is English-only and rule-based**: it's the offline/test
  fallback, not a second "language mode" — real natural multi-turn
  understanding (any language) comes from `OpenAIReasoner`.
- **`inventory_adjustments` increments are not atomic** (`select` then
  `upsert`, not a single SQL statement) — fine for demo-scale concurrent
  usage, not for real production race conditions.
- No real Stripe/calendar/WhatsApp integration yet (by design — see the
  project brief's "Do NOT add these yet" list).

## Local development

```
npm install
npm run dev        # http://localhost:3000/simulator — MockReasoner + in-memory by default
npm test            # vitest — policy, tools, all 5 business scenarios, Phase 1.5 regressions
npm run lint
npx tsc --noEmit    # strict type checking
npm run build       # production build, same as what Vercel runs
```

To run against the real Supabase project locally, copy `.env.example` to
`.env.local` and fill in `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`. The
Supabase-specific integration tests in
`__tests__/supabase-persistence.test.ts` auto-skip unless those two vars
are set in the environment running `vitest` — keep them unset for the main
`npm test` run so the rest of the suite stays deterministic and doesn't
leave rows in a shared database.
