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
  NO_INSTALLMENT_FEE,
  ScheduleError,
  assertInstallmentFee,
  computeInstallmentFeeMinor,
  generateSchedule,
  totalScheduledMinor,
  type InstallmentFeeConfig,
  type InstallmentFeeMode,
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
// Deliberately no fee field of any kind. The installment charge is the
// developer's fee, not a term the buyer fills in — it comes from the project
// default, with a staff-only override at createSale. Accepting a mode or a
// value from this form-facing schema would let a buyer post a zero charge and
// waive their own fee.

/**
 * The percentage half of a staff override: an optional whole number of basis
 * points. Absent — a blank input, a missing query param — means "use the
 * project default", which is exactly what an undefined override resolves to.
 * Composed into `FeeOverrideSchema` below, which is what callers parse.
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

/** Blank, absent or null all mean "not supplied", never "zero". */
const absentAsUndefined = (value: unknown) =>
  value === '' || value === null || value === undefined ? undefined : value

/**
 * A flat-fee override as it survives a URL and a hidden form field: digits of
 * minor units, exactly as stored. Minor units rather than the major-unit string
 * staff typed, because by this point the amount has already been parsed against
 * the project's currency once — re-parsing a decimal at every hop is how a
 * currency with no minor unit (RWF, UGX) ends up 100x out.
 */
const FixedFeeOverrideSchema = z.preprocess(
  absentAsUndefined,
  z
    .string()
    .regex(/^\d+$/, 'The installment charge must be a whole amount in minor units')
    .optional()
)

/**
 * The whole staff override — mode and value — as it travels from the sell form,
 * through the confirm URL, to the create action. Resolves to `undefined`
 * whenever the value for the chosen mode is absent, because a blank field means
 * "use the project default" and that is a different instruction from "charge
 * zero": conflating them would let an agent who left the field alone silently
 * waive the developer's fee.
 *
 * A bare `markupBps` with no `feeMode` still reads as a PERCENT override, so a
 * link minted before FIXED existed keeps quoting what it always quoted.
 *
 * Kept out of `PlanSelectionSchema` on purpose. That schema parses what a
 * buyer-shaped form submits; this one is only ever parsed on pages behind
 * `requireStaff()`, and `resolveInstallmentFee` discards the value anyway for a
 * BUYER actor.
 */
export const FeeOverrideSchema = z
  .object({
    feeMode: z.preprocess(absentAsUndefined, z.enum(['PERCENT', 'FIXED']).optional()),
    markupBps: MarkupOverrideSchema,
    fixedFeeMinor: FixedFeeOverrideSchema
  })
  .transform((value): InstallmentFeeConfig | undefined => {
    if (value.feeMode === 'FIXED') {
      const fixed = value.fixedFeeMinor as string | undefined
      return fixed === undefined
        ? undefined
        : { mode: 'FIXED', bps: 0, fixedMinor: BigInt(fixed) }
    }

    const bps = value.markupBps as number | undefined
    return bps === undefined ? undefined : { mode: 'PERCENT', bps, fixedMinor: 0n }
  })

/** The project's default charge, as the domain wants it. */
export function projectFeeConfig(project: {
  installmentFeeMode: InstallmentFeeMode
  installmentMarkupBps: number
  installmentFixedFeeMinor: bigint
}): InstallmentFeeConfig {
  return {
    mode: project.installmentFeeMode,
    bps: project.installmentMarkupBps,
    fixedMinor: project.installmentFixedFeeMinor
  }
}

/**
 * The charge a signed sale actually carries, out of its own snapshot. Every
 * display site derives the fee from this rather than from the project, which is
 * what makes re-rating a project leave signed contracts alone.
 */
export function saleFeeConfig(sale: {
  feeMode: InstallmentFeeMode
  markupBps: number
  fixedFeeMinor: bigint
}): InstallmentFeeConfig {
  return { mode: sale.feeMode, bps: sale.markupBps, fixedMinor: sale.fixedFeeMinor }
}

export interface SchedulePreview {
  entries: ScheduleEntryDraft[]
  totalMinor: bigint
  monthlyMinor: bigint | null
  finalMinor: bigint | null
  /**
   * The installment charge already baked into the entries, so a UI can show it
   * as its own line ("Installment charge: X") instead of leaving the buyer to
   * wonder why the total exceeds the price. Zero for a FULL plan, and zero for
   * a free installment plan in either mode.
   */
  feeMinor: bigint
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
    feeMinor: isInstallments
      ? computeInstallmentFeeMinor(input.priceMinor - input.depositMinor, input.fee)
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
    // services cannot produce an over-allocation — `allocateToEntry` caps every
    // payment at its entry's outstanding — but a hand-repaired sale could, and a buyer must
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
 * Settles which installment charge a new sale is signed at — mode and value
 * together, because a mode without its value charges the wrong thing.
 *
 * Two rules, both of which the buyer-facing flow depends on, and both unchanged
 * by the arrival of a second mode:
 *
 *  1. Only ADMIN and AGENT may deviate from the project default. A BUYER's
 *     `fee` is discarded rather than validated — this is the developer's fee,
 *     and a buyer who could post `{mode: 'FIXED', fixedMinor: 0n}` would waive
 *     it just as surely as one posting 0 bps. Discarding beats rejecting: the
 *     buy flow never sends the field, so a forged one is an attack, and the
 *     honest path must not be able to fail on it. Note the whole config is
 *     discarded as a unit — accepting a buyer's *mode* while defaulting the
 *     value would let them turn a 10% charge on a 200-million unit into
 *     whatever the project's unused fixed field happens to hold.
 *  2. A FULL plan is always free, in either mode. Nothing is financed, so there
 *     is nothing to charge for — the same normalisation `PlanSelectionSchema`
 *     applies to the deposit. Without it, every full-payment sale on a project
 *     that charges anything would die on `generateSchedule`'s FULL-plan guard.
 *
 * What it does not check is whether a FIXED fee fits inside the financed
 * amount: that needs a unit price this function is not given. `generateSchedule`
 * enforces it, and `createSale` turns the resulting ScheduleError into a
 * VALIDATION so a staff typo still lands on the form.
 *
 * Exported for the tests rather than for any caller: rule 1 is a security
 * control, and a security control that is only reachable through a function
 * needing a live Unit, Buyer and transaction is a security control nobody
 * tests. `createSale` remains its only production caller.
 */
export function resolveInstallmentFee(
  actor: SessionActor,
  input: { planType: PlanType; fee?: InstallmentFeeConfig },
  projectDefault: InstallmentFeeConfig
): InstallmentFeeConfig {
  if (input.planType !== 'INSTALLMENTS') return NO_INSTALLMENT_FEE

  const mayOverride = actor.role === 'ADMIN' || actor.role === 'AGENT'
  const resolved = mayOverride && input.fee !== undefined ? input.fee : projectDefault

  // Checked here rather than left to generateSchedule so a staff typo surfaces
  // as a validation message on the form instead of a raw ScheduleError.
  try {
    assertInstallmentFee(resolved)
  } catch (error) {
    throw new ServiceError(
      error instanceof ScheduleError
        ? error.message
        : `The installment charge must be a whole number of basis points between 0 and ${MAX_MARKUP_BPS}.`,
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
     * Staff-only override of the project's default installment charge — mode
     * and value. Omitted, or supplied by a BUYER actor, means "use the project
     * default". A buyer must never be able to set the fee they are charged.
     */
    fee?: InstallmentFeeConfig
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
    include: {
      project: {
        select: {
          id: true,
          currency: true,
          installmentFeeMode: true,
          installmentMarkupBps: true,
          installmentFixedFeeMinor: true
        }
      }
    }
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
  const fee = resolveInstallmentFee(actor, input, projectFeeConfig(unit.project))

  let drafts: ScheduleEntryDraft[]
  try {
    drafts = generateSchedule({
      planType: input.planType,
      priceMinor: unit.priceMinor,
      depositMinor,
      fee,
      months: input.termMonths,
      signedAt: input.signedAt
    })
  } catch (error) {
    // The likeliest arrival here is a flat fee larger than what the sale
    // finances — a misplaced decimal point on the sale form, or a project
    // default that is fine for a penthouse and absurd for a studio. It is a
    // data-entry mistake, so it comes back as a message on the form rather than
    // as a raw ScheduleError through the error boundary. Deposit-versus-price
    // mistakes land here too, and were previously unhandled.
    if (error instanceof ScheduleError) throw new ServiceError(error.message, 'VALIDATION')
    throw error
  }

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
        // All three snapshotted alongside the price: re-rating the project's
        // installment charge — or switching it between a percentage and a flat
        // fee — must not restate what this buyer agreed to pay. The mode is
        // stored with both values, so the sale remains readable without the
        // project it came from.
        feeMode: fee.mode,
        markupBps: fee.bps,
        fixedFeeMinor: fee.fixedMinor,
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
