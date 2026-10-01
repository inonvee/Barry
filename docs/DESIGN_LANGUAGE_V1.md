# BARRY Design Language V1

BARRY is not an admin panel with better colours. It is an operator you can read in one glance: what it is doing, what needs you, and what it will do next. One product language, two experiences — the **Owner** experience (calm, action-first, one business) and **HQ** (focused, fleet-wide, the founder's control plane). They share every primitive and differ in information architecture, not in permissions.

North star: quiet intelligence, luxury through restraint, clarity, agency, momentum.

## 1. Principles

1. **One brief, then the few things that matter.** Every surface opens with a sentence a person would say ("BARRY is running 7 businesses. 2 things need you."), not a grid of numbers.
2. **Editorial hierarchy.** Title → one supporting line → the ranked list → everything else behind disclosure. Never card soup, never four equal tiles.
3. **Status is a word with an icon.** Colour alone never carries meaning. Each status word has exactly one meaning (§6).
4. **Progressive disclosure.** Evidence, technical cause, raw ids and traces are one tap away, never on the brief.
5. **Consequence is stated before the button.** Scope, effect, reversibility and audit are written where the action is taken.
6. **Nothing fabricated.** Unavailable is a word, not a zero. Money stays in its currency. Timestamps are in the business's own timezone.

## 2. Typography

- Family: Geist Sans (loaded in `src/app/layout.tsx`); Geist Mono only for technical values.
- Scale: hero 26/34px semibold tight; section title 15–16px semibold; body 14px; supporting 13px; meta 12px; eyebrow 11px uppercase tracked. No text below 11px.
- Weight carries hierarchy; colour carries status. Tabular numerals for every number.

## 3. Colour roles (tokens in `src/app/globals.css`)

| Role | Token | Value |
| --- | --- | --- |
| Canvas | `--ds-canvas` | #f4f5f7 |
| Surface | `--ds-surface` | #ffffff |
| Muted surface | `--ds-surface-muted` | #f9fafb |
| Line | `--ds-line` | #e4e7ec |
| Ink / ink-2 | `--ds-ink`, `--ds-ink-2` | #101828 / #344054 |
| Muted / faint | `--ds-muted`, `--ds-faint` | #667085 / #98a2b3 |
| Accent | `--ds-accent` | #1d2939 (one dark accent; no brand colour, no neon) |

Status colours exist only inside `StatusPill` and `Notice`. No glassmorphism, no gradients, no neon.

## 4. Spacing, width, density, radius

- Spacing scale: 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40.
- Containers: narrow 48rem (briefs, Ask), regular 64rem (default), wide 72rem (fleet rows). Side gutter 16px on phones.
- Density: one idea per row; rows are 44px or taller on phones (full-width tap targets).
- Radius: 16px surfaces (`rounded-2xl`), 12px inner blocks, 8px controls, full pills.
- Surfaces are separated by a 1px hairline shadow, not borders. Few borders overall.

## 5. Surface hierarchy

1. `HeroBrief` — the sentence that matters, one supporting line, ≤2 actions.
2. `Section` — a titled surface with an optional subtitle and one right-hand action.
3. `FocusItem` / `FocusList` — a ranked thing that needs a person: title → why → the move → meta.
4. `ActivityRow` / `Timeline` — what happened: when · what · for whom · by whom · verified? · still needed?
5. `Disclosure` — details on demand (`<details>`; closed by default unless it holds a blocker).
6. `Technical` / `Kv` — raw values, allowed only in technical views and traces.

## 6. Status semantics (`StatusPill`)

| Word | Meaning | Never used for |
| --- | --- | --- |
| OK | Working as intended, verified | "nothing to show" |
| Needs attention | A person's decision or look is waiting | degraded systems |
| Blocked | A write could not or must not happen (paused, denied, failed) | pending |
| Degraded | BARRY or a provider is impaired; customers may be affected | not-ready setups |
| Not ready | Setup incomplete; nothing is broken | incidents |
| Simulator | Running on mock systems; test money | real-provider states |
| Unknown | No evidence yet; needs proof | zero |

"Expectedly blocked" (QA) is a `Blocked` word with a `PASS` qualifier: the refusal was the expected result.

## 7. Icons

Glyphs are text (✓ ! ✕ ~ ◦ ▷ ? •) inside pills so they render identically everywhere and never depend on an icon font. No illustrative icons, no animated avatar; BARRY's presence is a status chip with a sentence.

## 8. Navigation

- Owner: Today · Inbox · Money · Ask · Train BARRY · Settings.
- HQ: Focus · Fleet · Incidents · Activity · Money · Releases · BARRY · Settings; business focus mode has its own sub-navigation (Overview · Needs attention · Activity · Money · Capabilities · Launch · Controls · Technical).
- Desktop: primary nav in the header; phones: bottom bar with the four primary surfaces and "More" (a sheet). The command bar (⌘K / Ctrl+K; a bottom sheet on phones) switches business, goes to surfaces, finds incidents, conversations, approvals and payments, and hands a question to Ask. Only real read-model records are searchable.

## 9. Mobile

First-class at 390px: no horizontal scroll, no table squeezed into a phone (fleet rows stack), bottom navigation, one-handed command bar, full-width touch targets, safe-area padding. A second check at 430px.

## 10. Motion

Only state transitions: disclosure rotation and sheet entry. No decorative animation. `prefers-reduced-motion` disables all of it.

## 11. Loading, empty, error, blocked

- Loading: `Skeleton` lines in place, never a spinner page.
- Empty: `EmptyState` says what will appear here and why it is empty now.
- Error / unavailable: `Notice` with a status word; the source that failed is named; figures from it read "unavailable", never 0.
- Blocked: a `Blocked` pill plus the rule or control that blocked it, and the way back.

## 12. Destructive and consequential actions (`Confirmation`)

Every founder control and every destructive action states **scope**, **effect**, **reversibility** and **audit** before the button, requires a reason and an explicit confirmation, and is refused by the API without both. Identical state writes nothing and records nothing (no no-op audit).

## 13. Time, money, language

- Timestamps in the product read in the business's timezone in words (`formatLocal`: "Today 14:05", "Yesterday 09:12", "Tue 30 Sep, 14:05"). Raw ISO only in technical views.
- Money is per currency (`moneyParts`, `MoneyLine`). Two currencies are two figures with the note "separate currencies"; never a "+" and never a total.
- Owner surfaces never use admin-console language ("tenant", "record", "policyId"); HQ may name technical causes, under the customer impact.

## 14. Primitives

`src/components/ds/primitives.tsx` (server-safe): `StatusPill`, `Page`, `HeroBrief`, `Section`, `Disclosure`, `MetricInline`/`MetricLine`, `FocusItem`/`FocusList`, `ActivityRow`/`Timeline`, `EmptyState`, `Notice`, `Skeleton`, `ActionBar`, `Confirmation`, `Technical`, `Kv`, plus button/input class tokens.
`src/components/ds/shell.tsx` (client): `AppShell` (header, primary nav, presence chip, business switcher, command entry, mobile bottom nav + "More" sheet), `Sheet`, `BusinessSwitcher`, `PresenceChip`.
`src/components/ds/CommandBar.tsx` (client): `CommandBar`, `useCommandBar`, pure `rankResults`/`matchesQuery`.
Utilities: `src/lib/format/time.ts`, `src/lib/format/money.ts`.

The owner shell (`src/components/owner/OwnerShell.tsx`) and the HQ shell (`src/components/hq/HqShell.tsx`) are thin configurations of `AppShell`.
