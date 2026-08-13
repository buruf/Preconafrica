# PreCon Africa — design system

Derived from the owner's mockup (2026-08-12). One source of truth: every screen
and every PDF pulls from these tokens. If something needs a colour that is not
here, the answer is usually that it needs one of these colours.

## Brand

**Name:** PreCon Africa
**Tagline:** Buy early. Build the future.
**Positioning line (marketing surfaces only):** Preconstruction made simple. Transparent. Flexible. Built for Africa.

The mark is a stylised building: two stacked blocks, the taller in teal, the
shorter in navy, with window notches knocked out. Ships as inline SVG so it
costs no request and inherits currentColor where useful.

## Palette

| Token | Hex | Use |
|---|---|---|
| `navy-900` | `#0E2A47` | Primary buttons, active nav, PDF masthead rule, headings on light |
| `navy-800` | `#12324F` | Hover state for navy surfaces |
| `navy-100` | `#E8F1FA` | Info banners, selected-row tint |
| `teal-500` | `#21A0A0` | The mark, accents, progress fill, focus rings |
| `teal-100` | `#DCF2F1` | Accent tint behind icons |
| `ink` | `#0F172A` | Body text |
| `muted` | `#64748B` | Labels, secondary text |
| `line` | `#E7ECF1` | Card borders, table rules |
| `page` | `#F6F8FA` | App background |
| `surface` | `#FFFFFF` | Cards, sheets, bars |

Status, used identically in the UI and in PDFs:

| State | Background | Border | Text |
|---|---|---|---|
| Available / Paid | `#DCFCE7` | `#86EFAC` | `#15803D` |
| Reserved / Partial | `#FEF3C7` | `#FCD34D` | `#B45309` |
| Sold | `#FFE4E6` | `#FDA4AF` | `#BE123C` |
| Overdue | `#FEE2E2` | `#FCA5A5` | `#B91C1C` |
| Pending / Unavailable | `#F1F5F9` | `#E2E8F0` | `#64748B` |

Sold and Overdue are deliberately different reds: one is a fact about a unit,
the other is money someone owes today, and an arrears list that cannot be
distinguished at a glance from a sold-out floor is useless.

## Type

System stack (`ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`).
No webfont: buyers are on weak connections and a font file is the single
easiest thing to cut.

| Role | Size / weight |
|---|---|
| Screen title | 20px / 600 |
| Section heading | 16px / 600 |
| Body | 15px / 400 |
| Label, caption | 13px / 500, `muted` |
| Money, prominent | 22px / 700, tabular numerals |
| Money, inline | inherit / 600, tabular numerals |
| Hero figure | 32px / 700, tabular numerals |

The **hero figure** is the one number a screen exists to show — the buyer's
outstanding balance on the filled navy card, and nothing else so far. It is the
top of the ladder on purpose: a second 32px figure on the same screen means
neither is the hero. `StatCard size="hero"` is the only way to draw it, so a
later screen cannot invent 28px or 36px.

Every figure that can sit above another figure uses `font-variant-numeric:
tabular-nums`, so columns of money line up.

**Captions on a tinted status fill are `ink`, not `muted`.** `muted` (#64748B) is
chosen for its contrast on `surface` and on `page`; on the pale status fills it
falls to ≈4.35:1 (Available #DCFCE7) and ≈4.4:1 (Sold #FFE4E6), under the 4.5:1
floor. The unit tile's bed count is the one caption this applies to today. Size
and weight carry "secondary" there; the colour does not have to.

## Shape and spacing

- Card radius 12px, border `1px solid line`, shadow `0 1px 2px rgb(15 23 42 / 0.04)`.
- Button radius 10px, height 44px minimum — the tap-target floor, everywhere.
- Page padding 16px on mobile, 24px from `sm:`.
- Vertical rhythm in multiples of 4px.

## Navigation

A fixed bottom tab bar on mobile, icon over 11px label. Four tabs for staff,
three for a buyer — Projects is staff-only, and the rest are shown to everyone:

| Tab | Route | Shown to |
|---|---|---|
| Home | `/` | everyone |
| Projects | `/projects` | staff |
| Dashboard | `/dashboard` (buyer) or `/arrears` (staff) | everyone |
| Profile | `/profile` | everyone |

Active tab is `navy-900`; inactive `muted`. The active tab's icon additionally
sits on a `teal-100` pill — navy-versus-muted alone is too weak a signal at
11px on a phone. The bar is `surface` with a top `line` border and respects
`env(safe-area-inset-bottom)`. From `sm:` the same destinations move into a top
bar and the bottom bar is hidden — one nav definition, two presentations, so a
route is never reachable from one and not the other.

The **brand bar** — the mark plus the wordmark, linking home — is at the top of
every signed-in screen at every width. Below `sm:` it is the only place the mark
appears once login is behind you, and a screen with a bottom bar and no header
reads as a web page rather than as an app. From `sm:` it is the left half of the
top bar and the destinations are the right half.

**Team is not a fifth tab.** The bar tops out at the four destinations above,
and what a role sees is decided by the role, never by the user: every admin and
every agent sees the same four, every buyer the same three. Team is occasional
org administration — add an agent, set the letterhead logo — not a daily
destination, and a bar that is a different shape for an admin than for an agent
on the same screens is a worse trade than one extra tap. It is a link on
Profile, which is already "you and your organisation"; being a link on a page
rather than a tab also makes it identically reachable from both presentations,
which is the invariant the single destination list exists to hold.

Sign out lives on Profile too, not in the header. It cost a permanent 44px of
chrome on a 360px screen to host a control most people press once a week, a
thumb-slip from the nav on every single screen.

## Components

- **StatCard** — small `muted` label above a large tabular figure, optional
  tinted delta line. Used for Outstanding Balance, Total Overdue, Buyers Overdue.
- **UnitTile** — square-ish tile: unit name (15px/600) over bed count (12px
  `muted`), background/border/text from the status table. Grid of 3 across on
  mobile. This replaces the current list; it is the screen an agent shows a
  walk-in buyer.
- **ProgressBar** — `line` track, `teal-500` fill, rounded, with "16 / 36 paid"
  and a right-aligned percentage above it.
- **StatusPill** — same status colours, 11px/600, uppercase-ish label.
- **MoneyPair** — a `muted` label and a tabular figure, for the
  price/deposit/total rows that appear on nearly every screen and PDF.
- **Button / ButtonLink** — the navy primary, a `surface`-on-`line` secondary,
  and a `danger` drawn from the overdue triple. Both share one base, because
  half the "buttons" in this app navigate rather than submit and a nav-shaped
  button 2px shorter than the submit beside it is the classic tell. 44px floor
  on both.

Money and counts reach StatCard, MoneyPair and ProgressBar as **strings and
integers, already formatted** — `formatMinor` runs on the server. No component
here formats currency, and no `bigint` crosses into a client component.

## Currency

Amounts always render in the project's own currency via `formatMinor`. Where
the mockup shows a second line (`≈ USD 96,154`), that is **presentational only
and must never enter a calculation** — it is a static indicative rate held in
one place, clearly labelled approximate. No money decision anywhere in the
system reads it.

## PDFs

The same navy masthead rule, the same status colours, the same tabular figures.
Standard WinAnsi fonts only — no embedded font — which is why money prints as
`NGN 1,234.00` rather than `₦1,234.00`. Documents stay small; a buyer downloads
them on a phone.

## What this system is not

It is not a marketing site. The public surface is the login page and the
password-reset pages. Everything else is behind a session, and the buyer's half
of it is read-only: buyers watch their contract, staff transact.
