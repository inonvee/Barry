# Owner OS design grammar (Pass 1) — handoff for Pass 2 (Founder HQ)

Pass 1 rebuilt the Owner OS on one small grammar. Pass 2 (Founder HQ) should reuse it rather than invent a
second one. Everything below lives in `src/components/owner/os-ui.tsx` (primitives),
`src/components/owner/lang.tsx` (language), `src/components/owner/OwnerShell.tsx` (shell) and the
`o-*` tokens in `src/app/globals.css`.

## 1. Audit that drove the redesign (Phase A)

| Problem in the previous Owner UI | What Pass 1 did |
|---|---|
| Card-heavy pages: every section a large panel with an eyebrow, a hero and a paragraph | One container — the **Group** of rows. Heroes removed; a page is a header + groups. |
| Today counted "15 things" while Work showed 2 | One `activeWork()` definition read by Today, Work and presence. |
| Detail rendered inline, pushing lists off-screen on phones | **Sheet**: bottom sheet on phones, side panel on desktop. Lists stay in place. |
| Approve/decline were one tap | **ConfirmButton**: first tap arms and states the consequence, second tap acts. |
| Knowledge printed internal keys ("policy rule bookings auto allowed", "Business Genome", raw time zones) | Owner concepts (products, delivery, returns…); owner text quoted as written. |
| Rules and Knowledge disagreed about bookings | Both read the rule value via `policyWords`; permission and system capability shown side by side, never merged. |
| Train BARRY mixed rules, knowledge, setup and capability cards on one long page | Split into Rules, What BARRY knows, BARRY setup (journey + grouped blockers). |
| English only; no direction handling | Every surface EN + HE; logical properties; RTL from the first byte (cookie read server-side). |
| Inbox was a two-pane chat client | Customers: operational state rows; the conversation is a sheet, story first, messages folded. |

## 2. Tokens

`.barry-owner` scopes the Owner palette (light and dark sets in `globals.css`):

| Token | Use |
|---|---|
| `o-canvas` | page background |
| `o-surface` / `o-raised` / `o-sunken` | group background / selected control / inset areas (segments, notices) |
| `o-line` / `o-line-strong` | hairlines between rows / control outlines |
| `o-ink` / `o-ink-2` / `o-muted` / `o-faint` | title / body / secondary / tertiary text |
| `o-accent` | the one action colour (primary buttons, links, active tab) |
| `o-ok` · `o-warn` · `o-bad` · `o-info` · `o-violet` (+ `-bg`, `-line`) | state tones; violet = "BARRY noticed" |

Type scale: page title 26/30px semibold; section label 12px uppercase tracking 0.12em; row title 15px;
row sub 13px; figures use `.o-tabular`. Fonts: Geist (Latin), Heebo (Hebrew; first under `[dir=rtl]`).

## 3. Primitives

| Primitive | Contract |
|---|---|
| `PageHeader` | Title + one line. Deep pages get `back` (to More) on phones. Optional trailing control. |
| `SectionLabel` | Quiet label above a group; optional `action` ("All ›", "Teach a rule"). Has an `id` for anchors. |
| `Group` + `Row` | The default container. Row = `lead` (icon tile or initial) · `title` · `sub` (one line, truncated) · `end` (figure) / `chip` (state) / `endSub`. ≥ 56px tall. `href` or `onClick` makes it tappable and adds a direction-aware chevron. Title is `<bdi>`-isolated. |
| `Lead` | 36px rounded icon tile in a tone. |
| `Chip` / `Dot` | State as a **word**; colour is never the only signal. |
| `Sheet` | Detail: summary → detail → evidence. Bottom sheet (phones, 90dvh), side panel (≥ lg, 460px). Esc, scrim and close button dismiss; body scroll is locked; focus moves to close. Optional sticky `footer` for actions. |
| `Disclosure` | Evidence, provenance, history — one tap away, never in the way. |
| `Field` | Label above value inside a sheet (`<dl>`). |
| `Button` / `buttonClass` | `primary` · `secondary` · `danger` · `quiet`; ≥ 48px tall. |
| `ConfirmButton` | Consequential actions. First tap arms and shows `consequence`; second tap (`confirmLabel`) acts; Cancel disarms. |
| `Segments` | 2–4 equal-width tabs with counts (Work, Customers, Money period). |
| `Notice` | One-line status with a tone dot (`role=alert` for bad). |
| `Empty` / `LoadingRows` / `ErrorState` | Intentional states. Error says nothing changed in the business; technical detail is folded. |

## 4. Page patterns

- **Daily surface** (Today, Work, Money): header → (segments) → groups. At most one primary figure per
  page (Money "Made").
- **Index** (More): grouped rows, each with a live one-line hint.
- **Deep page** (Rules, Knowledge, Systems, Setup, Plan, Settings): `OsPage` frame (shell, back to More,
  owner read model in the owner's language, loading/error), then groups; each row opens a sheet.
- **Decision** (`DecisionSheet`): what · amount · why it's with you · what you decide · what happens next,
  then evidence folded; approve/decline via `ConfirmButton`; other options as buttons.
- **Conversation** (`ConversationSheet`): state chip, related decisions, where it stands, what happened,
  then "What BARRY did", requests and messages folded.

## 5. Language and direction

- `useOwnerLang()` → `{ lang, dir, t(en, he), setLang, adopt }`. Write both strings inline at the call site:
  `t("Needs you", "צריך אותך")`. Server models take `lang` and return finished words (`L(lang, en, he)`).
- Formatting helpers in `src/lib/owner/lang.ts`: `money`, `amount`, `number`, `ago`, `when`, `count`
  (Hebrew plural + gender), `cityOf` (no raw IANA zones).
- Use logical utilities only (`ps-`/`pe-`/`ms-`/`me-`/`start-`/`end-`/`text-start`/`border-s`); mirror
  directional icons with `rtl:-scale-x-100`.
- Isolate anything from records: `<bdi>` for names/amounts/titles, `dir="auto"` for free text and inputs.
  Codes, phone numbers and technical detail are `dir="ltr"`.
- Hebrew is native copy, not a translation: short, second person, masculine singular by default (product
  convention), "BARRY" stays Latin, maqaf before Latin names ("ל־BARRY").

## 6. Interaction rules

- Nothing consequential is one accidental tap away (approve, decline, start work, Ask actions).
- An instruction is never sent for the owner: "Ask BARRY to stop it" prefills Ask; the owner sends.
- Tapping a figure opens the records behind it.
- Deep links open sheets over the current page and keep old URLs working.
- Touch targets ≥ 44px; rows ≥ 56px; bottom bar 64px + safe-area inset; sticky composer sits above it.

## 7. Founder HQ (Pass 2) — what to reuse

Reuse the tokens, `os-ui` primitives, `Sheet`, `ConfirmButton` (founder controls are consequential), the
language layer if HQ needs Hebrew, and the page patterns above (fleet = daily surface; business detail =
deep page with sheets). HQ-only needs (dense tables, multi-business comparison) should be added as new
primitives in the same file with the same token vocabulary — not as a parallel kit.
