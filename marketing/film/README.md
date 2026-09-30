# Barry — "Coming Soon" product film (Remotion)

Isolated marketing project. Nothing here touches Barry's runtime; it has its own `package.json`.

## Run
```bash
cd marketing/film && npm install
npm run studio                       # preview
npm run audio                        # regenerate score + SFX (public/audio/mix-{he,en}.mp3)
npm run render:he                    # -> out/BarryComingSoon_HE.mp4
npm run render:en                    # -> out/BarryComingSoon_EN.mp4
node scripts/stills.mjs BarryComingSoon-EN:330,1230   # stills from the master
```
Composition IDs are `BarryComingSoon-HE` / `-EN` (Remotion forbids `_` in IDs); output files use the `_HE/_EN` names.
Remotion's own Chrome download may be blocked; `remotion.config.ts` falls back to a system Chromium (`BROWSER_EXECUTABLE`).
Official Remotion agent skills were installed with `npx skills add remotion-dev/skills` (folders git-ignored; re-run to restore).

## Spec
1920×1080, 30 fps, 2945 frames = **98.2 s** (HE and EN identical), H.264 CRF 18, AAC stereo.
All cuts are hard cuts; the corner day-clock (with a 24h line that fills as the day passes) connects the scenes.

## Story — "People stop. Barry works." (one day inside one business, no people on screen)
| Scene | Start | What it proves |
|---|---|---|
| 07:03 morning | 0:00.0 | An employee calls in sick; Barry's overnight briefing. **People stop. / Barry works.** (music starts here) |
| 10:26→10:28 dress | 0:10.0 | Ordinary WhatsApp ask → the six facts Barry checked → link → payment verified → order |
| 13:18 patience | 0:21.0 | "hello? ?? bro…" → the same calm answer, tracking re-checked. **Message 37. / Same patience.** |
| 15:44 close | 0:28.8 | 10% asked → Barry counters 5% inside his authority → deal closes, margin protected |
| 16:02 escalate | 0:34.5 | Stubborn customer → one concise owner decision (₪90 difference) → paid. **Not every decision needs you. / The important ones do.** |
| 18:42 owner | 0:44.5 | COO-style briefing; ₪1,240 recovery started; what went well → outcome cards |
| 21:16 supplier | 0:54.0 | "the usual order" → nine business signals → usual supplier chosen *for reasons*, not price → PO → "Done…Arriving Thursday." |
| montage | 1:06.0 | Fashion, spa, garage, delivery, wholesale, clinic — hard cuts on the beat |
| systems | 1:12.0 | 12 system modules; Barry acts across them. **Different business. Different systems. Same operator.** |
| adapt | 1:16.5 | **Your business doesn't adapt to Barry. / Barry adapts to your business.** |
| 00:37 night | 1:21.2 | The ₪1,240 customer from 18:42 comes back and pays. *Barry works.* |
| 07:01 next day | 1:25.3 | "Quiet night — the good kind." Sam: back today 💪 |
| brand | 1:30.7 | Vacuum → BARRY → **WORKS.** / **עובד.** → COMING SOON |

## Architecture
- `src/timing.ts` — one clock: scene durations, transition overlaps, cue table (`Q`). Scenes animate from it; the audio generator schedules from it. 120 BPM (15 f/beat); the montage sits on the beat grid.
- `src/motion.ts` — motion grammar (`enterSoft`, `enterImpact`, `exitSoft`, `stagger`, `cameraPush`, `systemPulse`, `connectionTravel`, shared easing/springs). No CSS transitions, no `Math.random` in render.
- `src/i18n/{he,en}.ts` — all copy as data. `src/lang.tsx` gives `dir`, `sx`/`mx` mirroring so the UI is authored once and mirrors for RTL. `Mixed`/`Ltr` isolate numbers, ₪, IDs, Latin names inside Hebrew.
- `src/ui/*` — Thread (bottom-anchored chat whose rows ease open and push history up), Notification, DayClock, DealRail, RouteTrack, ActivityLog, StatusLine, FactChip, BarryCore, StatusIndicator, VerificationChip, SystemConnection, CapabilityNode, SystemFact, CustomerMessage/BarryMessage/PhoneBubble, OwnerQuery, OwnerInsight, ApprovalCard, SupplierCard, PurchaseOrder, OutcomeCard, RevenueMetric.
- `src/scenes/*` — 13 scenes in a `Series` (hard cuts). Each renders into a 1920×1080 design stage scaled to the composition (the seam for a future 9:16 cut).
- Per-scene compositions are registered under Studio folders `Scenes-HE` / `Scenes-EN`.

## Final copy
See `src/i18n/he.ts` and `src/i18n/en.ts` (single source of truth). Each language was written natively, not translated line-for-line. The optional "Not AI that talks. AI that works." line was left out; the final frame is only BARRY WORKS / COMING SOON.
All numbers are illustrative product-vision data; data scenes carry a small "Illustrative data · product vision" tag. No screenshots are presented as real.

## Provenance
- Fonts (vendored in `public/fonts`, SIL OFL, from Google Fonts): Inter (latin), Heebo (hebrew), JetBrains Mono (latin) — variable files.
- Audio: 100 % original, procedurally synthesised by `scripts/generate-audio.mjs` (oscillators, FM plucks, filtered noise, algorithmic reverb). No samples, no third-party or licensed music.
- Visuals: original SVG/CSS. No stock footage, people, or logos.

## Known limits
- Audio was verified analytically (loudness, peak, per-second RMS, clipping), not by ear — a human listen is still recommended.
- MP4 masters (~37 MB each) are not committed; `previews/` has 720p versions. Regenerate with the render scripts.
- 9:16 is not built; scenes are stage-scaled but need per-scene recomposition.
