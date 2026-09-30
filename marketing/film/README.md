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
1920×1080, 30 fps, 2205 frames = **73.5 s**, H.264 CRF 18, AAC stereo. HE and EN have identical duration (per-language scene-length hooks exist in `src/timing.ts`).
Loudness ≈ −18.6 LUFS integrated, true peak ≈ −0.4 dBTP.

## Architecture
- `src/timing.ts` — one clock: scene durations, transition overlaps, cue table (`Q`). Scenes animate from it; the audio generator schedules from it. 120 BPM (15 f/beat); the montage sits on the beat grid.
- `src/motion.ts` — motion grammar (`enterSoft`, `enterImpact`, `exitSoft`, `stagger`, `cameraPush`, `systemPulse`, `connectionTravel`, shared easing/springs). No CSS transitions, no `Math.random` in render.
- `src/i18n/{he,en}.ts` — all copy as data. `src/lang.tsx` gives `dir`, `sx`/`mx` mirroring so the UI is authored once and mirrors for RTL. `Mixed`/`Ltr` isolate numbers, ₪, IDs, Latin names inside Hebrew.
- `src/ui/*` — BarryCore, StatusIndicator, VerificationChip, SystemConnection, CapabilityNode, SystemFact, CustomerMessage/BarryMessage/PhoneBubble, OwnerQuery, OwnerInsight, ApprovalCard, SupplierCard, PurchaseOrder, OutcomeCard, RevenueMetric.
- `src/scenes/*` — 8 scenes; `TransitionSeries` with a fade (open→verify) and a custom focus-pull (supplier→owner); every other join is a hard cut. Each scene renders into a 1920×1080 design stage scaled to the composition (the seam for a future 9:16 cut).
- Per-scene compositions are registered under Studio folders `Scenes-HE` / `Scenes-EN`.

## Scene / timing map (HE = EN)
| Scene | Start | Beat |
|---|---|---|
| open | 0:00 | black; four thoughts; three marks merge into a point of light |
| verify | 0:06.1 | message → camera pulls back on verified facts → collapse → "Barry doesn't guess / verifies" |
| operate | 0:15.4 | payment ledger resolves → five hard-cut outcomes on the beat → "Not just conversation. Action." |
| authority | 0:24.9 | 10% request beyond 5% authority → owner approval → reply → "think freely / authority stays with you" |
| supplier | 0:33.9 | owner phone "No problem, boss." → operating world → supplier choice → PO → "Done…ETA Thursday" (hero) |
| owner | 0:46.0 | "3 things" → weekly outcomes |
| scale | 0:56.0 | word-per-beat montage; capability web converges: one business, one operator |
| brand | 1:04.5 | audio vacuum → point → BARRY → tagline → COMING SOON (ends 1:13.5) |

## Final copy
See `src/i18n/he.ts` and `src/i18n/en.ts` (single source of truth). Ending — HE: "העסק שלך כבר עובד. / עכשיו תן לו מפעיל. / COMING SOON"; EN: "Your business already works. / Now give it an operator. / COMING SOON". The optional micro-line ("Not just conversation. Operation.") is in the copy files but deliberately not shown (cleaner final frame).
All numbers are illustrative product-vision data; scenes 3–6 carry a small "Illustrative data · product vision" tag. No screenshots are presented as real.

## Provenance
- Fonts (vendored in `public/fonts`, SIL OFL, from Google Fonts): Inter (latin), Heebo (hebrew), JetBrains Mono (latin) — variable files.
- Audio: 100 % original, procedurally synthesised by `scripts/generate-audio.mjs` (oscillators, FM plucks, filtered noise, algorithmic reverb). No samples, no third-party or licensed music.
- Visuals: original SVG/CSS. No stock footage, people, or logos.

## Optional VO (not required; film is text-led)
Only if wanted: HE/EN lines for the hero beats — "Barry doesn't guess. Barry verifies." / "Not just conversation. Action." / "Barry can think freely. Authority stays with you." / "One business. One operator." Keep it sparse, calm, and leave the audio vacuum before BARRY.

## Known limits
- Audio was verified analytically (loudness, peak, per-second RMS, clipping), not by ear — a human listen is still recommended.
- MP4 masters (~37 MB each) are not committed; `previews/` has 720p versions. Regenerate with the render scripts.
- 9:16 is not built; scenes are stage-scaled but need per-scene recomposition.
