# Deployment

BARRY is a standard Next.js App Router app with zero required environment
variables for Phase 1 (see `.env.example` — everything is optional until a
real LLM/Supabase/payment provider is wired in). That means the fastest
path to a live URL is Vercel's GitHub integration; no secrets need to be
configured to get the simulator running.

## One-time setup (done once, by whoever owns the Vercel account)

1. Go to https://vercel.com/new and import the `inonvee/barry` GitHub
   repository (or connect the Vercel GitHub App to the org if it isn't
   installed yet).
2. Framework preset: Next.js (auto-detected). Build command / output:
   defaults are correct (`next build`, `.next`).
3. No environment variables are required to deploy Phase 1. When the
   OpenAI-backed reasoner or Supabase persistence are wired in later, add:
   - `OPENAI_API_KEY` (server-only — never expose to the browser)
   - `BARRY_REASONER=openai`
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY`
4. Deploy. Vercel assigns a stable `*.vercel.app` preview URL immediately,
   plus a production URL once the branch is set as production (or on
   every push to `main`, per Vercel's default Git integration behavior).
5. Open the URL on a phone — the simulator (`/simulator`) is mobile-first
   by default; the root path (`/`) redirects there.

## Every subsequent push

Once the GitHub repo is connected, every push to a branch gets its own
Vercel preview deployment automatically, and pushes to the production
branch redeploy production — no manual redeploy step is needed. This
project's `claude/barry-core-phase-1-*` branch will get its own preview
URL the first time it's pushed after the Vercel project exists.

## Current status of this Phase 1 branch

This development environment has no Vercel account credentials attached
(no connector, no `VERCEL_TOKEN`), so the CLI-driven deploy
(`vercel --prod`) can't be run from here. The branch is pushed and fully
build-tested (`npm run build` passes) so it is ready to import the moment
someone with Vercel access completes the one-time setup above. If a
`VERCEL_TOKEN` (with scope over the target Vercel team) is added to this
environment's secrets, a future session can run:

```
npx vercel link --yes
npx vercel deploy --prebuilt --prod
```

to deploy directly from here instead.

## Known Phase 1 limitation: in-memory state on serverless

`ConversationStore` and `BarryBackend` (bookings, payments, approvals) are
process-memory singletons (see `docs/ARCHITECTURE.md`). Vercel serverless
functions are not guaranteed to stay warm between requests, so a
conversation's state can reset on a cold start in production. This is an
accepted Phase 1 tradeoff — the interfaces are already shaped so a
Supabase-backed implementation is a drop-in swap with no caller changes.
For local development (`npm run dev`) and for demoing from a single
device/session, state persists for as long as the dev server process
runs.

## Local development

```
npm install
npm run dev       # http://localhost:3000/simulator
npm run test       # vitest — policy, tools, and all 5 business scenarios
npm run lint
npx tsc --noEmit   # strict type checking
npm run build      # production build, same as what Vercel runs
```
