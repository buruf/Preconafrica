import type { ReactNode } from 'react'
import Link from 'next/link'

/**
 * The shared primitives, rebuilt against the tokens in docs/DESIGN.md.
 *
 * Two rules hold this file together and both are load-bearing for the two
 * restyling passes that come after this one:
 *
 *  1. No hex, ever. Every colour is a named token from tailwind.config.ts. A
 *     screen that needs "a slightly different grey" needs `muted`.
 *  2. Every interactive element clears 44px (`min-h-11`). That is the tap-target
 *     floor from DESIGN.md and it is not negotiable per-screen.
 *
 * The five original exports — PageHeader, Card, Field, Button, ErrorText — keep
 * their exact signatures; a couple of dozen files import them and this stage is
 * presentation only.
 */

/* ------------------------------------------------------------------ status */

/**
 * Every state the status table in DESIGN.md names, unit states and installment
 * states together, because they share one palette by design: a paid
 * installment and an available unit are the same green, and a walk-in buyer
 * reading a floor plate learns the colour once.
 *
 * `InstallmentStatus` from @/domain/status and `UnitStatus` from Prisma are
 * both assignable to this, so callers pass a derived status straight in without
 * a map of their own.
 */
export type StatusToken =
  | 'PAID'
  | 'PARTIAL'
  | 'OVERDUE'
  | 'PENDING'
  | 'AVAILABLE'
  | 'RESERVED'
  | 'SOLD'

/**
 * Token -> the triple that state is drawn in. Sold and Overdue are deliberately
 * different reds: one is a fact about a unit, the other is money owed today,
 * and an arrears list indistinguishable from a sold-out floor is useless.
 */
const STATUS_TONE: Record<StatusToken, string> = {
  PAID: 'bg-status-paid-bg border-status-paid-border text-status-paid-text',
  AVAILABLE: 'bg-status-paid-bg border-status-paid-border text-status-paid-text',
  PARTIAL: 'bg-status-partial-bg border-status-partial-border text-status-partial-text',
  RESERVED: 'bg-status-partial-bg border-status-partial-border text-status-partial-text',
  SOLD: 'bg-status-sold-bg border-status-sold-border text-status-sold-text',
  OVERDUE: 'bg-status-overdue-bg border-status-overdue-border text-status-overdue-text',
  PENDING: 'bg-status-pending-bg border-status-pending-border text-status-pending-text'
}

/** Title-case, so 'PARTIAL' prints as 'Partial' rather than shouting. */
function statusLabel(status: StatusToken): string {
  return status.charAt(0) + status.slice(1).toLowerCase()
}

/**
 * The one pill in the app. It replaces `StatusBadge`, which drew the same four
 * installment states from Tailwind's stock palette while three other screens
 * hand-rolled their own unit-status tones — four sources of truth for one idea.
 * `children` overrides the label for the rare case that needs wording rather
 * than the bare state ("3 overdue").
 */
export function StatusPill({
  status,
  children,
  className = ''
}: {
  status: StatusToken
  children?: ReactNode
  className?: string
}) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[status]} ${className}`}
    >
      {children ?? statusLabel(status)}
    </span>
  )
}

/* ------------------------------------------------------------------ layout */

export function PageHeader({
  title,
  subtitle,
  action
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-navy-900">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  )
}

/**
 * A caller-supplied padding utility, e.g. `p-0` or `p-6`. Not `px-*`/`py-*`:
 * those compose with `p-4` rather than replacing it, and a caller writing
 * `px-0` means "narrower", not "unpadded".
 */
const OVERRIDES_PADDING = /(?:^|\s)p-[^\s]+/

/**
 * The two surfaces a card is drawn on.
 *
 * `navy` exists because the mockup's hero figure — a buyer's outstanding balance
 * — sits on a filled navy card rather than on `surface`. It is a variant of this
 * component rather than a `bg-navy-900` in a caller's `className` on purpose:
 * `bg-navy-900` and `bg-surface` are the same property at the same specificity,
 * so which one won would come down to Tailwind's emission order — the exact trap
 * the padding override below exists to close. Owning both fills here means a
 * caller cannot get it wrong, and the border moves with the fill.
 */
export type CardTone = 'surface' | 'navy'

const CARD_TONE: Record<CardTone, string> = {
  surface: 'border-line bg-surface',
  navy: 'border-navy-900 bg-navy-900'
}

export function Card({
  children,
  tone = 'surface',
  className = ''
}: {
  children: ReactNode
  tone?: CardTone
  className?: string
}) {
  // Tailwind emits `.p-0` *before* `.p-4`, so appending a caller's `p-0` after
  // the default lost on source order and silently did nothing — three screens
  // already wrap a divided list in `<Card className="p-0">` believing it
  // worked. Dropping the default when the caller names their own padding is
  // what makes the override mean what everyone reads it as. (The alternative,
  // a `tailwind-merge` dependency, is a lot of bytes for one utility.)
  const padding = OVERRIDES_PADDING.test(className) ? '' : 'p-4'

  return (
    <div
      className={`rounded-card border shadow-card ${CARD_TONE[tone]} ${padding} ${className}`}
    >
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------- forms */

/**
 * The shell every text input, select and textarea wears.
 *
 * Exported because three screens legitimately need a bare control rather than
 * `Field`'s — a `<select>`, a `<textarea>`, an input that has to be `disabled`
 * by a client component — and each of them had grown its own
 * `min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base` string.
 * Five copies of a control shell is five ways for one border colour to be
 * wrong, which is exactly what this file exists to prevent.
 *
 * `text-base`, not `text-sm`: anything under 16px makes iOS Safari zoom the
 * whole page on focus. The focus ring is teal — the accent from DESIGN.md —
 * rather than the browser default.
 */
export const CONTROL_CLASS =
  'min-h-11 w-full rounded-btn border border-line bg-surface px-3 text-base text-ink outline-none placeholder:text-muted focus:border-teal-500 focus:ring-2 focus:ring-teal-100'

/**
 * A `<select>` on the shared control shell, for the six places that need one.
 *
 * A plain element rather than anything clever: a native select is the right
 * control on a phone (it opens the platform picker), it works with no
 * JavaScript, and it is the reason the arrears project filter can be a
 * server-rendered GET form rather than a client component.
 */
export function Select({
  name,
  children,
  defaultValue,
  required,
  disabled,
  onChange,
  className = ''
}: {
  name: string
  children: ReactNode
  defaultValue?: string
  required?: boolean
  disabled?: boolean
  /**
   * Optional, and the select stays uncontrolled with or without it — the one
   * caller that passes it (the new-project form's naming pattern) only wants to
   * mirror the chosen value into state so it can redraw the unit-name preview.
   * Without JavaScript nothing is listening, and the select still posts.
   */
  onChange?: React.ChangeEventHandler<HTMLSelectElement>
  className?: string
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue}
      required={required}
      disabled={disabled}
      onChange={onChange}
      className={`${CONTROL_CLASS} ${className}`}
    >
      {children}
    </select>
  )
}

export function Field({
  label,
  name,
  type = 'text',
  required,
  defaultValue,
  placeholder,
  hint,
  onChange,
  children
}: {
  /** Usually a string; a node when the row carries a control, e.g. a
   *  password field's Show/Hide toggle sitting opposite its label. */
  label: ReactNode
  name: string
  type?: string
  required?: boolean
  defaultValue?: string | number
  placeholder?: string
  hint?: string
  /**
   * Optional, and the input stays uncontrolled either way — same contract as
   * `Select`'s. The new-project form uses it to follow "Units / floor" and
   * "First floor no." so the unit-position rows and their name previews can
   * keep up with what has been typed.
   */
  onChange?: React.ChangeEventHandler<HTMLInputElement>
  children?: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-ink">
        {label}
        {required ? <span className="text-status-overdue-text"> *</span> : null}
      </span>
      {children ?? (
        <input
          name={name}
          type={type}
          required={required}
          defaultValue={defaultValue}
          placeholder={placeholder}
          onChange={onChange}
          className={CONTROL_CLASS}
        />
      )}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  )
}

export type ButtonVariant = 'primary' | 'secondary' | 'danger'

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  // The navy primary. One per screen, on the thing the screen is for.
  primary: 'bg-navy-900 text-surface hover:bg-navy-800 active:bg-navy-800',
  // The quieter one: same size and the same 44px floor, no fill. Used beside
  // a primary, never instead of one.
  secondary: 'border border-line bg-surface text-navy-900 hover:bg-page active:bg-page',
  // Destructive, and drawn from the overdue triple rather than a fourth red.
  danger:
    'border border-status-overdue-border bg-status-overdue-bg text-status-overdue-text hover:bg-status-overdue-border'
}

/** Shape and size, shared by `Button` and `ButtonLink` so the two cannot drift. */
const BUTTON_BASE =
  'min-h-11 rounded-btn px-4 text-sm font-semibold transition-colors disabled:opacity-50'

export function Button({
  children,
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button {...props} className={`${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${className}`}>
      {children}
    </button>
  )
}

/**
 * A link that looks like a button, because half the "buttons" in this app
 * navigate rather than submit — "New project", "Open my dashboard", "Sell".
 * Those were each hand-rolling their own copy of the primary fill, which is how
 * a nav-shaped button ends up 2px shorter than a submit one beside it.
 *
 * An <a>, not a <button>: it goes somewhere, so it must be openable in a new
 * tab and readable as a link to a screen reader.
 */
export function ButtonLink({
  href,
  children,
  variant = 'primary',
  external = false,
  className = ''
}: {
  href: string
  children: ReactNode
  variant?: ButtonVariant
  /**
   * Renders a plain `<a>` instead of a `Link`, for a target the App Router must
   * keep its hands off: the arrears CSV is a route handler that answers with
   * `Content-Disposition: attachment`, and a client-side navigation to it would
   * have the router try to parse a spreadsheet as a React payload. Prefetching
   * it would also mean generating the export on hover.
   */
  external?: boolean
  className?: string
}) {
  const classes = `inline-flex items-center justify-center ${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${className}`

  if (external) {
    return (
      <a href={href} className={classes}>
        {children}
      </a>
    )
  }

  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  )
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null
  return (
    <p className="rounded-btn border border-status-overdue-border bg-status-overdue-bg px-3 py-2 text-sm text-status-overdue-text">
      {children}
    </p>
  )
}

/* --------------------------------------------------------------- inventory */

/**
 * One unit in the floor plate — the tile the mockup builds the inventory screen
 * out of, and the thing an agent turns their phone round to show a walk-in
 * buyer. Colour carries the status, so a floor reads as a picture rather than as
 * a column of words.
 *
 * A link, not a button: it opens the unit's own screen (imagery, specs, price,
 * and Sell / View sale), so it must be openable in a new tab, announced as a
 * link, and reachable by keyboard. Three across at 375px gives a ~98px square,
 * comfortably past the 44px tap-target floor — the floor is why the tile has a
 * minimum height at all rather than sizing to its two lines of text.
 */
export function UnitTile({
  name,
  bedrooms,
  status,
  href,
  className = ''
}: {
  name: string
  bedrooms: number
  status: StatusToken
  href: string
  className?: string
}) {
  return (
    <Link
      href={href}
      className={`flex min-h-[4.5rem] flex-col items-center justify-center gap-0.5 rounded-btn border px-1 text-center transition-opacity active:opacity-80 ${STATUS_TONE[status]} ${className}`}
    >
      <span className="text-[15px] font-semibold leading-none">{name}</span>
      {/* One colour for the bed count on every tile, deliberately not the status
          text colour: it is the same secondary fact everywhere, and drawing it in
          three different colours would make it look like it meant three
          different things.
          `ink`, not the `muted` DESIGN.md gives captions on `surface`. Muted
          (#64748B) on the Available fill (#DCFCE7) is ~4.35:1 and on the Sold
          fill (#FFE4E6) ~4.4:1 — both under the 4.5:1 floor for 12px text, which
          is a real failure at the size and on the screen this is read on. `ink`
          clears it with room to spare (~16:1 and ~15:1) and the size and weight
          still carry "secondary". Captions on a tinted fill are the documented
          exception to the muted rule — see DESIGN.md "Type". */}
      <span className="text-[12px] leading-none text-ink">{bedrooms} bed</span>
    </Link>
  )
}

/**
 * What the tile colours mean. A grid of coloured squares is only self-evident
 * once, and the person it has to be self-evident for is the buyer looking over
 * the agent's shoulder.
 *
 * Takes the states rather than hard-coding three, so the same legend serves the
 * unit grid (Available / Reserved / Sold) and anything later that needs the
 * installment triple. `statusLabel` supplies the wording, so a legend can never
 * disagree with the pill it explains.
 */
export function StatusLegend({
  statuses,
  className = ''
}: {
  statuses: StatusToken[]
  className?: string
}) {
  return (
    <ul className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 ${className}`}>
      {statuses.map((status) => (
        <li key={status} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`h-3 w-3 shrink-0 rounded-[3px] border ${STATUS_TONE[status]}`}
          />
          <span className="text-[13px] font-medium text-muted">{statusLabel(status)}</span>
        </li>
      ))}
    </ul>
  )
}

/* -------------------------------------------------------------- figures */

/**
 * A muted label over one large tabular figure — Outstanding Balance, Total
 * Overdue, Buyers Overdue.
 *
 * `value` is a string, always. Money reaches this component already through
 * `formatMinor` on the server, because a bigint cannot cross into a client
 * component and a float must never touch a money path. A count arrives as
 * `String(n)` for the same reason it arrives here at all: this component
 * formats nothing.
 */
export function StatCard({
  label,
  value,
  sub,
  tone = 'default',
  surface = 'default',
  size = 'default',
  className = ''
}: {
  label: string
  value: string
  /** Optional second line — "2 overdue", "of 36 units". */
  sub?: ReactNode
  /** Tints the figure and the sub-line. `default` is ink on surface. */
  tone?: 'default' | 'good' | 'warn' | 'bad'
  /**
   * `navy` fills the card and inverts the text — the mockup's hero balance.
   * It overrides `tone`, because a red figure on navy is unreadable and the
   * whole point of the filled card is that this is *the* number on the screen;
   * anything urgent about it goes in `sub`, which stays legible.
   */
  surface?: 'default' | 'navy'
  /** `hero` is the 32px figure the filled balance card carries. */
  size?: 'default' | 'hero'
  className?: string
}) {
  const navy = surface === 'navy'

  const figureTone = navy
    ? 'text-surface'
    : {
        default: 'text-navy-900',
        good: 'text-status-paid-text',
        warn: 'text-status-partial-text',
        bad: 'text-status-overdue-text'
      }[tone]

  // navy-100 is DESIGN.md's light navy tint; on the filled card it is the label
  // colour `muted` would be on surface, and it keeps the label clearly secondary
  // to the figure instead of competing with it in plain white.
  const labelTone = navy ? 'text-navy-100' : 'text-muted'
  const subTone = navy ? 'text-navy-100' : tone === 'default' ? 'text-muted' : figureTone

  return (
    <Card tone={navy ? 'navy' : 'surface'} className={className}>
      <p className={`text-[13px] font-medium ${labelTone}`}>{label}</p>
      <p
        className={`mt-1 font-bold leading-tight tabular-nums ${
          size === 'hero' ? 'text-[32px]' : 'text-[22px]'
        } ${figureTone}`}
      >
        {value}
      </p>
      {sub ? <p className={`mt-1 text-[13px] ${subTone}`}>{sub}</p> : null}
    </Card>
  )
}

/**
 * "16 / 36 paid" with a right-aligned percentage over a teal fill.
 *
 * The percentage is computed here from two integers rather than accepted as a
 * number, so no caller can round it a second, different way — and it is
 * integer arithmetic, because this sits directly beneath money and a
 * floating-point 99.99999% under a settled balance is the kind of detail that
 * costs a developer a phone call.
 */
export function ProgressBar({
  value,
  total,
  noun = 'paid',
  className = ''
}: {
  value: number
  total: number
  /** The word after the fraction: "paid", "sold", "issued". */
  noun?: string
  className?: string
}) {
  const safeTotal = total > 0 ? total : 0
  const clamped = Math.max(0, Math.min(value, safeTotal))
  const percent = safeTotal === 0 ? 0 : Math.round((clamped * 100) / safeTotal)

  return (
    <div className={className}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-muted tabular-nums">
          {clamped} / {safeTotal} {noun}
        </span>
        <span className="text-[13px] font-semibold text-navy-900 tabular-nums">{percent}%</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${clamped} of ${safeTotal} ${noun}`}
      >
        <div className="h-full rounded-full bg-teal-500" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

/**
 * A muted label and a tabular figure, side by side. The price / deposit / total
 * row that appears on nearly every screen.
 *
 * `value` is a pre-formatted string for the same reason as StatCard's: money is
 * formatted once, on the server, by `formatMinor`.
 */
export function MoneyPair({
  label,
  value,
  tone = 'default',
  className = ''
}: {
  label: string
  value: string
  tone?: 'default' | 'good' | 'bad'
  className?: string
}) {
  const valueTone = {
    default: 'text-ink',
    good: 'text-status-paid-text',
    bad: 'text-status-overdue-text'
  }[tone]

  return (
    <div className={`flex items-baseline justify-between gap-3 ${className}`}>
      <span className="text-[13px] text-muted">{label}</span>
      <span className={`text-[15px] font-semibold tabular-nums ${valueTone}`}>{value}</span>
    </div>
  )
}
