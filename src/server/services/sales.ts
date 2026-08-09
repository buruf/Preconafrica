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
    deposit: z.string().default('0'),
    termMonths: z.coerce.number().int().min(1).max(360).default(DEFAULT_TERM_MONTHS)
  })
  .transform((value) => (value.planType === 'FULL' ? { ...value, deposit: '0' } : value))

export interface SchedulePreview {
  entries: ScheduleEntryDraft[]
  totalMinor: bigint
  monthlyMinor: bigint | null
  finalMinor: bigint | null
}

/** Pure wrapper — no database access, so the UI can preview before committing. */
export function previewSchedule(input: ScheduleInput): SchedulePreview {
  const entries = generateSchedule(input)
  const isInstallments = input.planType === 'INSTALLMENTS'

  return {
    entries,
    totalMinor: totalScheduledMinor(entries),
    monthlyMinor: isInstallments ? entries[0].amountDueMinor : null,
    finalMinor: isInstallments ? entries[entries.length - 1].amountDueMinor : null
  }
}

export interface SaleSummary {
  paidToDateMinor: bigint
  balanceMinor: bigint
  nextDue: { dueDate: Date; amountMinor: bigint } | null
  overdueCount: number
}

export function summariseSale(
  sale: {
    priceMinor: bigint
    depositMinor: bigint
    scheduleEntries: Array<{ dueDate: Date; amountDueMinor: bigint; amountPaidMinor: bigint }>
  },
  asOf: Date
): SaleSummary {
  const entries = [...sale.scheduleEntries].sort(
    (a, b) => a.dueDate.getTime() - b.dueDate.getTime()
  )

  const allocatedMinor = entries.reduce((sum, e) => sum + e.amountPaidMinor, 0n)
  const paidToDateMinor = sale.depositMinor + allocatedMinor
  const balanceMinor = sale.priceMinor - paidToDateMinor

  const next = entries.find((e) => outstandingMinor(e) > 0n)

  return {
    paidToDateMinor,
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

export async function createSale(
  actor: SessionActor,
  input: {
    buyerId: string
    unitId: string
    planType: PlanType
    deposit: string
    termMonths: number
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
    include: { project: { select: { id: true, currency: true } } }
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
  const drafts = generateSchedule({
    planType: input.planType,
    priceMinor: unit.priceMinor,
    depositMinor,
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
  unit: { select: { id: true, name: true, floor: true, bedrooms: true, sizeSqm: true } },
  project: { select: { id: true, name: true, location: true, currency: true } },
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
