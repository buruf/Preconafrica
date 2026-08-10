import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { allocatePayment, type Allocation } from '@/domain/allocation'
import { toMinor } from '@/domain/currency'

export const RecordPaymentSchema = z.object({
  saleId: z.string().min(1),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Enter a valid amount').refine(
    (v) => Number(v) > 0,
    'Amount must be greater than zero'
  ),
  receivedAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date'),
  method: z.enum(['BANK_TRANSFER', 'MOBILE_MONEY', 'CASH', 'CHEQUE', 'OTHER']),
  reference: z.string().trim().max(80).optional(),
  note: z.string().trim().max(500).optional()
})

export type RecordPaymentInput = z.infer<typeof RecordPaymentSchema>

/**
 * Writes allocations and recomputes each touched entry's amountPaidMinor from
 * its allocation rows — recomputed, not incremented, so a retry or a concurrent
 * write cannot leave the cached total disagreeing with the audit trail.
 *
 * Exported for reuse by prisma/seed.ts, which needs the exact same
 * write-then-recompute logic and previously hand-rolled a copy of it. The
 * parameter stays `Prisma.TransactionClient` only — never widened to accept
 * the plain client — so this function's contract is unconditionally
 * "runs inside a transaction". The seed satisfies that by opening its own
 * `prisma.$transaction` around each call rather than this service loosening
 * its guarantee to suit a caller that doesn't itself need one.
 */
export async function applyAllocations(
  tx: Prisma.TransactionClient,
  paymentId: string,
  allocations: Allocation[],
  receivedAt: Date
): Promise<string[]> {
  const settled: string[] = []

  for (const allocation of allocations) {
    await tx.paymentAllocation.create({
      data: {
        paymentId,
        scheduleEntryId: allocation.entryId,
        amountMinor: allocation.amountMinor
      }
    })

    const rows = await tx.paymentAllocation.findMany({
      where: { scheduleEntryId: allocation.entryId, payment: { voidedAt: null } },
      select: { amountMinor: true }
    })
    const total = rows.reduce((sum, row) => sum + row.amountMinor, 0n)

    const entry = await tx.scheduleEntry.findUniqueOrThrow({
      where: { id: allocation.entryId },
      select: { amountDueMinor: true }
    })

    const fullySettled = total >= entry.amountDueMinor
    await tx.scheduleEntry.update({
      where: { id: allocation.entryId },
      data: { amountPaidMinor: total, paidAt: fullySettled ? receivedAt : null }
    })

    if (fullySettled) settled.push(allocation.entryId)
  }

  return settled
}

export async function recordPayment(actor: SessionActor, input: RecordPaymentInput) {
  assertRole(actor, ['ADMIN', 'AGENT'])

  const sale = await prisma.sale.findFirst({
    where: { id: input.saleId, orgId: actor.orgId },
    select: { id: true, currency: true }
  })
  if (!sale) throw new ServiceError('Sale not found', 'NOT_FOUND')

  const amountMinor = toMinor(input.amount, sale.currency)
  const receivedAt = new Date(input.receivedAt)

  // A long installment schedule can cascade a single payment across dozens
  // of entries, and applyAllocations does several sequential round trips per
  // entry (create + findMany + findUniqueOrThrow + update). Against a remote
  // database Prisma's 5s default interactive-transaction timeout is not
  // enough headroom for that — paying off a whole outstanding balance in one
  // payment is ordinary behaviour, not an edge case, and it must not fail
  // with a transaction timeout. maxWait is the time allowed to *acquire* the
  // transaction slot; timeout is the time the transaction body itself may run.
  return prisma.$transaction(
    async (tx) => {
      const entries = await tx.scheduleEntry.findMany({
        where: { saleId: sale.id },
        orderBy: { sequence: 'asc' },
        select: { id: true, sequence: true, amountDueMinor: true, amountPaidMinor: true }
      })

      const { allocations, overpaymentMinor } = allocatePayment(entries, amountMinor)

      const payment = await tx.payment.create({
        data: {
          orgId: actor.orgId,
          saleId: sale.id,
          amountMinor,
          receivedAt,
          method: input.method,
          reference: input.reference || null,
          note: input.note || null,
          recordedByUserId: actor.userId
        }
      })

      const settledEntryIds = await applyAllocations(tx, payment.id, allocations, receivedAt)

      // Close the sale once nothing is outstanding. Fetched and compared in
      // JS rather than via a Prisma field-to-field reference —
      // `tx.scheduleEntry.fields` is unreliable on a transaction client, and
      // a schedule is at most a few hundred rows, so re-fetching here is
      // cheap and correct.
      const afterEntries = await tx.scheduleEntry.findMany({
        where: { saleId: sale.id },
        select: { amountDueMinor: true, amountPaidMinor: true }
      })
      if (afterEntries.every((e) => e.amountPaidMinor >= e.amountDueMinor)) {
        await tx.sale.update({ where: { id: sale.id }, data: { status: 'COMPLETED' } })
      }

      return { paymentId: payment.id, overpaymentMinor, settledEntryIds }
    },
    { maxWait: 10_000, timeout: 30_000 }
  )
}

export async function voidPayment(actor: SessionActor, paymentId: string, reason: string) {
  // Voiding rewrites balances, so it is ADMIN-only.
  assertRole(actor, ['ADMIN'])
  if (!reason.trim()) throw new ServiceError('A reason is required to void a payment')

  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, orgId: actor.orgId },
    include: { allocations: { select: { scheduleEntryId: true } } }
  })
  if (!payment) throw new ServiceError('Payment not found', 'NOT_FOUND')
  if (payment.voidedAt) throw new ServiceError('That payment is already void', 'CONFLICT')

  const affectedEntryIds = payment.allocations.map((a) => a.scheduleEntryId)

  // Same reasoning as recordPayment's transaction: a payment that originally
  // cascaded across many entries touches just as many on the way back out
  // when voided, so this needs the same widened timeout rather than the
  // 5s default.
  await prisma.$transaction(
    async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: { voidedAt: new Date(), voidedByUserId: actor.userId, voidReason: reason.trim() }
      })

      // The payment row survives for audit; only its allocations are
      // withdrawn. RESTRICT on PaymentAllocation -> Payment/ScheduleEntry
      // means allocations must go before the payment could ever be deleted;
      // here the payment itself is never deleted, only voided, so this
      // ordering just keeps the recompute below straightforward.
      await tx.paymentAllocation.deleteMany({ where: { paymentId } })

      for (const entryId of affectedEntryIds) {
        const rows = await tx.paymentAllocation.findMany({
          where: { scheduleEntryId: entryId, payment: { voidedAt: null } },
          select: { amountMinor: true }
        })
        const total = rows.reduce((sum, row) => sum + row.amountMinor, 0n)
        const entry = await tx.scheduleEntry.findUniqueOrThrow({
          where: { id: entryId },
          select: { amountDueMinor: true }
        })

        await tx.scheduleEntry.update({
          where: { id: entryId },
          data: {
            amountPaidMinor: total,
            // `undefined` means "leave paidAt unchanged"; `null` means
            // "clear it". This is intentional, not a typo: an entry that is
            // STILL fully covered after this void (some other payment
            // already covered it) keeps its original settlement date rather
            // than being restamped by a void it wasn't even part of
            // settling. Only an entry that drops below fully-paid has its
            // paidAt cleared.
            paidAt: total >= entry.amountDueMinor ? undefined : null
          }
        })
      }

      await tx.sale.update({ where: { id: payment.saleId }, data: { status: 'ACTIVE' } })
    },
    { maxWait: 10_000, timeout: 30_000 }
  )
}
