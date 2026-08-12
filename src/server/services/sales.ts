import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { constraintTargetIncludes, reserveUnit } from '@/server/services/units'
import { toMinor } from '@/domain/currency'
import {
  DEFAULT_TERM_MONTHS,
  DEPOSIT_SEQUENCE,
  MAX_MARKUP_BPS,
  computeMarkupMinor,
  generateSchedule,
  totalScheduledMinor,
  type PlanType,
  type ScheduleEntryDraft,
  type ScheduleInput
} from '@/domain/schedule'
import { deriveStatus, outstandingMinor } from '@/domain/status'

export { DEFAULT_TERM_MONTHS }

/**
 * E.164: a leading +, a non-zero country code digit, then up to 14 more digits.
 * No spaces or separators are stored, so the same number is never recorded two
 * ways — which matters when SMS delivery is added later.
 */
const E164 = /^\+[1-9]\d{7,14}$/

export const BuyerRegistrationSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name is required').max(120),
  phone: z
    .string()
    .trim()
    .regex(E164, 'Enter your phone number with country code, e.g. +2348031234567'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  address: z.string().trim().max(300).optional(),
  password: z.string().min(8, 'Use at least 8 characters')
})

export type BuyerRegistrationInput = z.infer<typeof BuyerRegistrationSchema>

export const PlanSelectionSchema = z
  .object({
    unitId: z.string().min(1),
    planType: z.enum(['FULL', 'INSTALLMENTS']),
    // Blank means "no deposit" — the buy form's deposit field is optional and
    // an empty submission must read as zero, not fail toMinor downstream.
    deposit: z
      .string()
      .default('0')
      .transform((value) => (value.trim() === '' ? '0' : value.trim())),
    // An empty termMonths input submits '' — z.coerce would turn that into 0
    // and fail min(1), so map empty to undefined first and let the default apply.
    termMonths: z.preprocess(
      (value) => (value === '' || value === null ? undefined : value),
      z.coerce.number().int().min(1).max(360).default(DEFAULT_TERM_MONTHS)
    )
  })
  .transform((value) => (value.planType === 'FULL' ? { ...value, deposit: '0' } : value))
// Deliberately no markup field. The installment charge is the developer's fee,
// not a term the buyer fills in — it comes from the project default, with a
// staff-only override at createSale. Accepting it from this form-facing schema
// would let a buyer post markupBps=0 and waive their own fee.

/**
 * The staff override as it travels from the sell form, through the confirm
 * URL, to the create action: an optional whole number of basis points.
 *
 * Kept out of `PlanSelectionSchema` on purpose. That schema parses what a
 * buyer-shaped form submits; this one is only ever parsed on pages behind
 * `requireStaff()`, and `resolveMarkupBps` discards the value anyway for a
 * BUYER actor. Absent — a blank input, a missing query param — means "use the
 * project default", which is exactly what an undefined override resolves to.
 */
export const MarkupOverrideSchema = z.preprocess(
  (value) => (value === '' || value === null ? undefined : value),
  z.coerce
    .number()
    .int('The installment charge must be a whole number of basis points')
    .min(0)
    .max(MAX_MARKUP_BPS)
    .optional()
)

export interface SchedulePreview {
  entries: ScheduleEntryDraft[]
  totalMinor: bigint
  monthlyMinor: bigint | null
  finalMinor: bigint | null
  /**
   * The installment charge already baked into the entries, so a UI can show it
   * as its own line ("Installment charge: X") instead of leaving the buyer to
   * wonder why the total exceeds the price. Zero for a FULL plan, and zero for
   * an installment plan at 0 bps.
   */
  markupMinor: bigint
}

/** Pure wrapper — no database access, so the UI can preview before committing. */
export function previewSchedule(input: ScheduleInput): SchedulePreview {
  // Runs first: it validates the whole input, so everything below can trust it.
  const entries = generateSchedule(input)
  const isInstallments = input.planType === 'INSTALLMENTS'

  // `monthlyMinor`/`finalMinor` describe the *monthly* installments, and the
  // deposit is now the first entry in the array — so they are picked from the
  // entries that are actually months. Reading entries[0] blindly would print a
  // buyer's deposit under "Monthly".
  const monthly = entries.filter((entry) => entry.sequence !== DEPOSIT_SEQUENCE)

  return {
    entries,
    totalMinor: totalScheduledMinor(entries),
    monthlyMinor: isInstallments ? monthly[0].amountDueMinor : null,
    finalMinor: isInstallments ? monthly[monthly.length - 1].amountDueMinor : null,
    markupMinor: isInstallments
      ? computeMarkupMinor(input.priceMinor - input.depositMinor, input.markupBps)
      : 0n
  }
}

export interface SaleSummary {
  /** Everything the contract obliges the buyer to pay: price plus any markup. */
  totalOwedMinor: bigint
  paidToDateMinor: bigint
  balanceMinor: bigint
  nextDue: { dueDate: Date; amountMinor: bigint } | null
  overdueCount: number
}

/**
 * Both sides of this summary now come from the schedule and nowhere else.
 *
 * Paid-to-date is the sum of what has actually been allocated. `depositMinor` is
 * deliberately absent from the input type: it records the agreed terms and feeds
 * `generateSchedule`, but it is not money received. The deposit reaches this
 * figure the way every other amount does — by being a schedule entry that a
 * `Payment` was allocated against. Adding it as a separate term is what let a
 * buyer self-declare a 90% deposit, pay nothing, and read 90% paid on every
 * dashboard and PDF.
 *
 * Total-owed is the sum of what is due, and `priceMinor` is absent for the
 * mirror-image reason. Once a plan can carry an installment markup, the price is
 * no longer the amount owed — an installment buyer owes price plus markup — so
 * subtracting from the price would under-report the balance by the entire fee
 * and show a sale as settled while a month of charge was still outstanding. The
 * schedule sums to exactly what is owed by construction (see `generateSchedule`),
 * which makes it the one figure that stays right for FULL plans, zero-markup
 * plans, and marked-up plans alike.
 */
export function summariseSale(
  sale: {
    scheduleEntries: Array<{ dueDate: Date; amountDueMinor: bigint; amountPaidMinor: bigint }>
  },
  asOf: Date
): SaleSummary {
  const entries = [...sale.scheduleEntries].sort(
    (a, b) => a.dueDate.getTime() - b.dueDate.getTime()
  )

  const totalOwedMinor = entries.reduce((sum, e) => sum + e.amountDueMinor, 0n)
  const paidToDateMinor = entries.reduce((sum, e) => sum + e.amountPaidMinor, 0n)
  const balanceMinor = totalOwedMinor - paidToDateMinor

  const next = entries.find((e) => outstandingMinor(e) > 0n)

  return {
    totalOwedMinor,
    paidToDateMinor,
    // Clamped because this function does not own the rows it is handed. The
    // services cannot produce an over-allocation — `allocatePayment` never
    // exceeds an entry's due — but a hand-repaired sale could, and a buyer must
    // never be shown a negative balance.
    balanceMinor: balanceMinor > 0n ? balanceMinor : 0n,
    nextDue: next ? { dueDate: next.dueDate, amountMinor: outstandingMinor(next) } : null,
    overdueCount: entries.filter((e) => deriveStatus(e, asOf) === 'OVERDUE').length
  }
}

const DUPLICATE_EMAIL_MESSAGE = 'An account with that email already exists. Please sign in.'

export async function registerBuyer(orgId: string, input: BuyerRegistrationInput) {
  // Cheap pre-check: gives the common case (no race) a clean answer without
  // burning a transaction. It is not sufficient on its own — two concurrent
  // registrations for the same email can both pass it, so the transaction
  // below still has to guard the actual insert.
  const existing = await prisma.user.findUnique({ where: { email: input.email } })
  if (existing) {
    throw new ServiceError(DUPLICATE_EMAIL_MESSAGE, 'CONFLICT')
  }

  const passwordHash = await bcrypt.hash(input.password, 10)

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          orgId,
          email: input.email,
          passwordHash,
          fullName: input.fullName,
          role: 'BUYER'
        }
      })

      const buyer = await tx.buyer.create({
        data: {
          orgId,
          userId: user.id,
          fullName: input.fullName,
          phone: input.phone,
          email: input.email,
          address: input.address ?? null
        }
      })

      return { buyerId: buyer.id, userId: user.id }
    })
  } catch (error) {
    // The loser of a concurrent double-registration lands here: the
    // pre-check above passed for both, but only one `tx.user.create` can
    // win the unique-email constraint. Convert that race loss into the same
    // friendly conflict the pre-check reports, rather than letting a raw
    // Prisma error escape. Confirm the violated constraint actually
    // involves `email` before claiming a duplicate-email conflict — a
    // P2002 on some other constraint must not be mislabelled.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      constraintTargetIncludes(error.meta?.target, 'email')
    ) {
      throw new ServiceError(DUPLICATE_EMAIL_MESSAGE, 'CONFLICT')
    }
    throw error
  }
}

/**
 * Settles which installment charge a new sale is signed at.
 *
 * Two rules, both of which the buyer-facing flow depends on:
 *
 *  1. Only ADMIN and AGENT may deviate from the project default. A BUYER's
 *     `markupBps` is discarded rather than validated — this is the developer's
 *     fee, and a buyer who could post `markupBps: 0` would waive it. Discarding
 *     beats rejecting: the buy flow never sends the field, so a forged one is an
 *     attack, and the honest path must not be able to fail on it.
 *  2. A FULL plan is always 0. Nothing is financed, so there is nothing to
 *     charge for — the same normalisation `PlanSelectionSchema` applies to the
 *     deposit. Without it, every full-payment sale on a project that charges a
 *     markup would die on `generateSchedule`'s FULL-plan guard.
 *
 * Exported for the tests rather than for any caller: rule 1 is a security
 * control, and a security control that is only reachable through a function
 * needing a live Unit, Buyer and transaction is a security control nobody
 * tests. `createSale` remains its only production caller.
 */
export function resolveMarkupBps(
  actor: SessionActor,
  input: { planType: PlanType; markupBps?: number },
  projectDefaultBps: number
): number {
  if (input.planType !== 'INSTALLMENTS') return 0

  const mayOverride = actor.role === 'ADMIN' || actor.role === 'AGENT'
  const resolved =
    mayOverride && input.markupBps !== undefined ? input.markupBps : projectDefaultBps

  // Checked here rather than left to generateSchedule so a staff typo surfaces
  // as a validation message on the form instead of a raw ScheduleError.
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > MAX_MARKUP_BPS) {
    throw new ServiceError(
      `The installment charge must be a whole number of basis points between 0 and ${MAX_MARKUP_BPS}.`,
      'VALIDATION'
    )
  }

  return resolved
}

export async function createSale(
  actor: SessionActor,
  input: {
    buyerId: string
    unitId: string
    planType: PlanType
    deposit: string
    termMonths: number
    /**
     * Staff-only override of the project's default installment charge, in basis
     * points. Omitted — or supplied by a BUYER actor — means "use the project
     * default". A buyer must never be able to set the fee they are charged.
     */
    markupBps?: number
    signedAt: Date
  }
) {
  // ADMIN and AGENT act on behalf of any buyer in their organisation — that
  // is their job. A BUYER may only ever create a sale for themselves; every
  // other combination is refused before any lookup runs, so the response
  // cannot be used to probe whether some other buyerId exists in the org.
  assertRole(actor, ['ADMIN', 'AGENT', 'BUYER'])
  if (actor.role === 'BUYER' && input.buyerId !== actor.buyerId) {
    throw new ServiceError('You do not have access to this resource.', 'FORBIDDEN')
  }

  const unit = await prisma.unit.findFirst({
    where: { id: input.unitId, project: { orgId: actor.orgId } },
    include: { project: { select: { id: true, currency: true, installmentMarkupBps: true } } }
  })
  if (!unit) throw new ServiceError('Unit not found', 'NOT_FOUND')
  if (unit.status !== 'AVAILABLE') {
    throw new ServiceError('That unit is no longer available', 'CONFLICT')
  }

  const buyer = await prisma.buyer.findFirst({
    where: { id: input.buyerId, orgId: actor.orgId }
  })
  if (!buyer) throw new ServiceError('Buyer not found', 'NOT_FOUND')

  const depositMinor = toMinor(input.deposit, unit.project.currency)
  const markupBps = resolveMarkupBps(actor, input, unit.project.installmentMarkupBps)

  const drafts = generateSchedule({
    planType: input.planType,
    priceMinor: unit.priceMinor,
    depositMinor,
    markupBps,
    months: input.termMonths,
    signedAt: input.signedAt
  })

  return prisma.$transaction(async (tx) => {
    // Conditional claim inside the transaction. Two agents pressing Confirm at
    // the same moment: one wins, the other gets a clean message.
    const claimed = await reserveUnit(tx, unit.id, 'SOLD')
    if (!claimed) throw new ServiceError('That unit was just taken by someone else', 'CONFLICT')

    const sale = await tx.sale.create({
      data: {
        orgId: actor.orgId,
        projectId: unit.project.id,
        unitId: unit.id,
        buyerId: buyer.id,
        planType: input.planType,
        // Snapshotted: repricing the unit later must not alter this contract.
        priceMinor: unit.priceMinor,
        depositMinor,
        // Snapshotted alongside the price: re-rating the project's installment
        // charge later must not restate what this buyer agreed to pay.
        markupBps,
        currency: unit.project.currency,
        termMonths: input.planType === 'INSTALLMENTS' ? input.termMonths : null,
        signedAt: input.signedAt,
        createdByUserId: actor.userId,
        scheduleEntries: { create: drafts }
      }
    })

    return { saleId: sale.id }
  })
}

const saleInclude = {
  unit: {
    select: {
      id: true,
      name: true,
      floor: true,
      bedrooms: true,
      sizeSqm: true,
      // What the buyer is actually buying, as a picture. Selected here rather
      // than fetched per page, so the staff sale page and the buyer dashboard
      // show the same imagery out of the same query.
      layoutImageUrl: true,
      renderImageUrls: true
    }
  },
  project: {
    select: { id: true, name: true, location: true, currency: true, heroImageUrl: true }
  },
  buyer: { select: { id: true, fullName: true, phone: true, email: true, address: true } },
  scheduleEntries: { orderBy: { sequence: 'asc' } },
  payments: {
    orderBy: { receivedAt: 'desc' },
    include: { allocations: true, document: true }
  },
  documents: true
} as const

export async function getSaleForStaff(actor: SessionActor, saleId: string) {
  assertRole(actor, ['ADMIN', 'AGENT'])
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, orgId: actor.orgId },
    include: saleInclude
  })
  if (!sale) throw new ServiceError('Sale not found', 'NOT_FOUND')
  return sale
}

/**
 * Every buyer of the actor's organisation, for the "sell to an existing buyer"
 * picker on the staff sale form.
 *
 * Staff-only and org-scoped: the list names people, and one developer's client
 * roster must never be selectable from another's form. Returns only what the
 * option label needs — no address, no email, and nothing about their sales.
 */
export async function listBuyers(actor: SessionActor) {
  assertRole(actor, ['ADMIN', 'AGENT'])
  return prisma.buyer.findMany({
    where: { orgId: actor.orgId },
    orderBy: { fullName: 'asc' },
    select: { id: true, fullName: true, phone: true }
  })
}

export async function getSaleForBuyer(actor: SessionActor & { buyerId: string }) {
  // Scoped by buyerId from the session, never from a route parameter — a guessed
  // URL returns nothing rather than someone else's contract.
  const sale = await prisma.sale.findFirst({
    where: { buyerId: actor.buyerId, orgId: actor.orgId, status: { not: 'CANCELLED' } },
    orderBy: { createdAt: 'desc' },
    include: saleInclude
  })
  return sale
}
