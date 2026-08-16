import { formatMinor } from '@/domain/currency'

/**
 * The audit log's vocabulary and its renderer: what a change looks like, how
 * two states are reduced to only what moved between them, and how one entry
 * becomes a sentence a non-technical developer can read.
 *
 * Pure — no database, no clock, no Prisma. The service layer builds entries out
 * of these types and the /audit page renders them with `describeAuditEntry`;
 * neither of those two ever formats anything itself.
 */

/* --------------------------------------------------------------- values */

/**
 * One side of a change, tagged with what kind of thing it is.
 *
 * Tagged rather than a bare string because the renderer has to know: money must
 * go through `formatMinor` with its own currency (an amount with no currency is
 * not an amount, and a NGN figure printed as KES is a lie), an enum has to be
 * said in English rather than shouted, and an image URL must never appear in a
 * sentence at all.
 *
 * Money is a *string* of minor units, not a bigint: JSON has no BigInt, this
 * value is stored in a Json column and read back on a server component that
 * must not hand a bigint to the client. The string is exact — it is
 * `bigint.toString()` and it round-trips.
 */
export type AuditValue =
  | { kind: 'money'; minor: string; currency: string }
  | { kind: 'text'; value: string }
  /** A database enum — UnitStatus, SaleStatus, UserRole. Rendered title-cased. */
  | { kind: 'enum'; value: string }
  | { kind: 'number'; value: number }
  /** An ISO date string. Rendered as the day, never a timestamp. */
  | { kind: 'date'; value: string }
  /** An image URL. The URL is kept as history; the sentence never prints it. */
  | { kind: 'image'; url: string }
  /** Absent: null, unset, or not yet existing. Renders as "none". */
  | { kind: 'none' }

/** One field that moved, and what it moved between. */
export interface AuditChange {
  field: string
  from: AuditValue
  to: AuditValue
}

/** A named set of values, as handed to `diffValues`. */
export type AuditFields = Record<string, AuditValue>

/**
 * The ids and snapshots a sentence needs that the entity itself does not carry.
 *
 * Every field is optional and every field is a snapshot or an id — nothing here
 * is authoritative, and nothing here is read back to make a decision. It exists
 * so a row can say "on unit 4C" and link to the sale without the page having to
 * join four tables per row.
 */
export interface AuditContext {
  saleId?: string
  projectId?: string
  projectName?: string
  unitId?: string
  /** The unit's name at the time — what "on unit 4C" is built from. */
  unitName?: string
  buyerName?: string
  documentNumber?: string
  documentType?: string
  /** Why. Today: the reason an admin typed when voiding a payment. */
  reason?: string
  /** The currency an amount in `amountMinor` is denominated in. */
  currency?: string
  /** A single amount the event is *about* — the payment recorded or voided. */
  amountMinor?: string
  /** Which schedule entry a payment settled: 0 is the deposit. */
  entrySequence?: number
  /** A short phrase describing a new sale's plan: "12-month installment plan". */
  planLabel?: string
  /** How many units a newly created project generated. */
  unitCount?: number
}

/**
 * An entry as the renderer sees it. Structurally what the `AuditEntry` row is,
 * with `changes` and `context` already parsed — so this module never has to
 * know that Prisma stores them as `Json`.
 */
export interface AuditEntryView {
  id: string
  actorName: string
  actorRole: string
  action: string
  entityType: string
  entityId: string
  entityLabel: string | null
  changes: AuditChange[]
  context: AuditContext
  createdAt: Date
}

/* ---------------------------------------------------------- constructors */

/** Money, or `none` when the column is null. */
export function money(minor: bigint | null | undefined, currency: string): AuditValue {
  return minor === null || minor === undefined
    ? { kind: 'none' }
    : { kind: 'money', minor: minor.toString(), currency }
}

export function text(value: string | null | undefined): AuditValue {
  return value === null || value === undefined || value === '' ? { kind: 'none' } : { kind: 'text', value }
}

export function enumValue(value: string | null | undefined): AuditValue {
  return value === null || value === undefined ? { kind: 'none' } : { kind: 'enum', value }
}

export function number(value: number | null | undefined): AuditValue {
  return value === null || value === undefined ? { kind: 'none' } : { kind: 'number', value }
}

export function date(value: Date | null | undefined): AuditValue {
  return value === null || value === undefined
    ? { kind: 'none' }
    : { kind: 'date', value: value.toISOString() }
}

export function image(url: string | null | undefined): AuditValue {
  return url === null || url === undefined || url === '' ? { kind: 'none' } : { kind: 'image', url }
}

/* ---------------------------------------------------------------- diffing */

/**
 * Two values are the same when every tagged field of them is. Written out
 * rather than `JSON.stringify` compared, because key order is not part of a
 * value's identity and `stringify` says it is.
 */
export function sameValue(a: AuditValue, b: AuditValue): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'none':
      return true
    case 'money':
      return a.minor === (b as typeof a).minor && a.currency === (b as typeof a).currency
    case 'image':
      return a.url === (b as typeof a).url
    default:
      return a.value === (b as { value: string | number }).value
  }
}

/**
 * What actually changed, and nothing else.
 *
 * The whole reason the log is readable: a price change has to read as
 * `priceMinor: 14500000000 → 14900000000`, not as two hundred fields of which
 * one moved. Fields present in `before` but absent from `after` are not
 * "cleared" — they were simply not part of this edit — so only keys present in
 * `after` are considered, and a key missing from `before` is treated as
 * `{kind:'none'}`, which is how a null → value change ends up reading as
 * "none → …" rather than being silently dropped.
 *
 * Order follows `after`'s key order, so a caller decides how its own sentence
 * reads.
 */
export function diffValues(before: AuditFields, after: AuditFields): AuditChange[] {
  const changes: AuditChange[] = []
  for (const field of Object.keys(after)) {
    const from = before[field] ?? { kind: 'none' as const }
    const to = after[field]
    if (!sameValue(from, to)) changes.push({ field, from, to })
  }
  return changes
}

/* -------------------------------------------------------------- rendering */

/** 'AVAILABLE' -> 'Available', 'BANK_TRANSFER' -> 'Bank transfer'. */
function humanEnum(value: string): string {
  const words = value.toLowerCase().split('_').join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The field names staff would use, for the ones whose column name is jargon. */
const FIELD_LABEL: Record<string, string> = {
  priceMinor: 'price',
  sizeSqm: 'size',
  bedrooms: 'bedrooms',
  name: 'name',
  status: 'status',
  role: 'role',
  heroImageUrl: 'building photo',
  layoutImageUrl: 'floor plan',
  logoUrl: 'logo',
  renderImageUrls: 'renders',
  installmentFeeMode: 'installment charge basis',
  installmentMarkupBps: 'installment charge',
  installmentFixedFeeMinor: 'installment charge',
  reminderDaysBefore: 'reminder lead time',
  overdueNoticeDaysAfter: 'overdue notice delay',
  expectedCompletion: 'expected completion',
  location: 'location',
  currency: 'currency'
}

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field
}

/** One value, said in words. Never a URL, never a raw enum, never a bigint. */
export function renderValue(value: AuditValue): string {
  switch (value.kind) {
    case 'money':
      // The only place money is formatted for the log, and it always carries
      // the currency the amount was recorded in — never a project's current one.
      return formatMinor(BigInt(value.minor), value.currency)
    case 'enum':
      return humanEnum(value.value)
    case 'number':
      return String(value.value)
    case 'date':
      return value.value.slice(0, 10)
    case 'image':
      // The URL is stored, but a sentence with a signed blob URL in it is not a
      // sentence. `describeChange` says set/removed/replaced instead.
      return 'an image'
    case 'none':
      return 'none'
    case 'text':
      return value.value
  }
}

/**
 * One change as a phrase: `price NGN 145,000,000.00 → NGN 149,000,000.00`.
 *
 * Images are the exception, and are the reason this is not just two
 * `renderValue` calls with an arrow between them: "building photo an image →
 * an image" tells the reader nothing, so an image change reads as what it is.
 */
export function describeChange(change: AuditChange): string {
  const label = fieldLabel(change.field)

  if (change.from.kind === 'image' || change.to.kind === 'image') {
    if (change.to.kind === 'none') return `${label} removed`
    if (change.from.kind === 'none') return `${label} set`
    return `${label} replaced`
  }

  return `${label} ${renderValue(change.from)} → ${renderValue(change.to)}`
}

/** "installment 2", "the deposit" — the schedule's own words, kept in step. */
function entryPhrase(sequence: number | undefined): string | null {
  if (sequence === undefined) return null
  return sequence === 0 ? 'the deposit' : `installment ${sequence}`
}

/** "on unit 4C", or nothing when the entry is not about a unit. */
function onUnit(context: AuditContext, entityLabel: string | null): string {
  const name = context.unitName ?? entityLabel
  return name ? ` on unit ${name}` : ''
}

function contextAmount(context: AuditContext): string | null {
  if (!context.amountMinor || !context.currency) return null
  return formatMinor(BigInt(context.amountMinor), context.currency)
}

/**
 * "a KES 183,333.33 payment", or just "a payment" when the figure did not
 * survive. It should always survive — both payment verbs record it — but a
 * sentence that reads "a undefined payment" would be worse than a vaguer one.
 */
function paymentFigure(amount: string | null): string {
  return amount ? `a ${amount} payment` : 'a payment'
}

/** The changed fields, joined — `price A → B, bedrooms 3 → 4`. */
export function describeChanges(changes: AuditChange[]): string {
  return changes.map(describeChange).join(', ')
}

/**
 * What one entry says.
 *
 * `sentence` is the whole thing bar the timestamp, which the page appends
 * because only the page knows the reader's locale. `href` is where the row
 * links, or null when the entry refers to something with nowhere to go.
 *
 * Every branch reads the entry and only the entry — never the live Unit, Sale
 * or User. That is the point of the snapshots: an entry about unit 4C keeps
 * saying 4C after the unit is renamed, because the name it prints is the one
 * that was true when it happened.
 *
 * An unrecognised action does not throw and does not render as JSON. It falls
 * through to a plain, honest sentence, so an entry recorded by a newer version
 * of the app is still readable by an older page — and so adding a verb is never
 * blocked on remembering to add a case here.
 */
export function describeAuditEntry(entry: AuditEntryView): { sentence: string; href: string | null } {
  const who = entry.actorName
  const context = entry.context
  const amount = contextAmount(context)
  const unit = onUnit(context, entry.entityLabel)
  const changes = describeChanges(entry.changes)

  const sentence = (() => {
    switch (entry.action) {
      case 'sale.created': {
        const buyer = context.buyerName ? ` to ${context.buyerName}` : ''
        const plan = context.planLabel ? ` on a ${context.planLabel}` : ''
        const price = amount ? ` at ${amount}` : ''
        return `${who} sold unit ${context.unitName ?? entry.entityLabel ?? '—'}${buyer}${plan}${price}`
      }
      case 'sale.status_changed': {
        const status = entry.changes.find((change) => change.field === 'status')
        const move = status
          ? ` from ${renderValue(status.from)} to ${renderValue(status.to)}`
          : ''
        return `${who} changed the sale${unit}${move}`
      }
      case 'sale.cancelled':
        // No code path reaches this yet — there is no cancel flow. The verb is
        // here so the day one lands, the log reads correctly on the first
        // cancellation rather than after someone remembers this file.
        return `${who} cancelled the sale${unit}${context.reason ? ` — “${context.reason}”` : ''}`

      case 'payment.recorded': {
        const against = entryPhrase(context.entrySequence)
        return `${who} recorded ${paymentFigure(amount)}${unit}${against ? ` — ${against}` : ''}`
      }
      case 'payment.voided':
        return `${who} voided ${paymentFigure(amount)}${unit}${
          context.reason ? ` — “${context.reason}”` : ''
        }`

      case 'unit.updated':
        return `${who} changed unit ${entry.entityLabel ?? '—'}${changes ? ` — ${changes}` : ''}`
      case 'unit.status_changed': {
        const status = entry.changes.find((change) => change.field === 'status')
        const move = status
          ? ` from ${renderValue(status.from)} to ${renderValue(status.to)}`
          : ''
        return `${who} changed unit ${entry.entityLabel ?? '—'}${move}`
      }

      case 'project.created': {
        const units = context.unitCount === undefined ? '' : ` with ${context.unitCount} units`
        return `${who} created the project ${entry.entityLabel ?? '—'}${units}`
      }
      case 'project.updated':
        return `${who} changed the project ${entry.entityLabel ?? '—'}${changes ? ` — ${changes}` : ''}`

      case 'document.issued': {
        const type = context.documentType ? humanEnum(context.documentType).toLowerCase() : 'document'
        const number = context.documentNumber ? ` ${context.documentNumber}` : ''
        return `${who} issued ${type}${number}${unit}`
      }

      case 'user.agent_added':
        return `${who} added ${entry.entityLabel ?? 'an agent'} as an agent`
      case 'user.agent_deactivated':
        return `${who} deactivated the agent ${entry.entityLabel ?? '—'}`
      case 'user.buyer_registered':
        return `${who} registered the buyer ${entry.entityLabel ?? '—'}`
      case 'user.password_changed':
        return `${who} changed their own password`
      case 'user.password_reset':
        return `${who} reset their password with an emailed link`
      case 'user.role_changed': {
        // Also not reachable yet: nothing changes a role today. Same reasoning
        // as sale.cancelled — the vocabulary exists before the feature does.
        const role = entry.changes.find((change) => change.field === 'role')
        const move = role ? ` from ${renderValue(role.from)} to ${renderValue(role.to)}` : ''
        return `${who} changed ${entry.entityLabel ?? 'a user'}’s role${move}`
      }

      case 'org.updated':
        return `${who} changed the organisation${changes ? ` — ${changes}` : ''}`

      default:
        // Unknown verb. Say what is actually known, in that order, so the row
        // is still useful: who, the raw action, and what it was about.
        return `${who} performed ${entry.action} on ${entry.entityType.toLowerCase()} ${
          entry.entityLabel ?? entry.entityId
        }${changes ? ` — ${changes}` : ''}`
    }
  })()

  return { sentence, href: auditEntryHref(entry) }
}

/**
 * Where a row links, or null.
 *
 * Only to pages that exist and that an admin may open. A Payment and a Document
 * both link to their sale rather than to themselves — neither has a page of its
 * own, and the sale is where an admin goes to see what happened to it. Users and
 * the organisation link to /team, which is the surface that administers both.
 *
 * Null whenever the id needed for the link was not captured, which is
 * deliberate: a link that 404s is worse than no link.
 */
export function auditEntryHref(entry: AuditEntryView): string | null {
  const { saleId, projectId, unitId } = entry.context

  switch (entry.entityType) {
    case 'Sale':
      return `/sales/${entry.entityId}`
    case 'Payment':
    case 'Document':
      return saleId ? `/sales/${saleId}` : null
    case 'Unit': {
      const id = unitId ?? entry.entityId
      return projectId ? `/projects/${projectId}/units/${id}` : null
    }
    case 'Project':
      return `/projects/${entry.entityId}`
    case 'User':
    case 'Organization':
      return '/team'
    default:
      return null
  }
}
