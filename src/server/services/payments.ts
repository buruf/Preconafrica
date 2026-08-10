import type { Prisma, SaleStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { applyAllocations, lockSale, recomputeEntries } from '@/server/services/allocations'
import { issueReceipt } from '@/server/documents/issue'
import { allocatePayment, AllocationError } from '@/domain/allocation'
import { toMinor } from '@/domain/currency'

/**
 * Schema-level shape check only — this cannot know which currency the sale is
 * denominated in, so it rejects obvious garbage (letters, multiple dots) but
 * not "too many decimal places for this currency". Hardcoding two decimals
 * here would be wrong for RWF, UGX, XOF, XAF and DJF, which have none. That
 * check needs the loaded sale and happens in recordPayment() below via
 * toMinor(), exactly as units.ts does for unit prices.
 */
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/

/**
 * "Greater than zero" without going through `Number`: a string of digits is
 * positive if and only if at least one of them is not a zero. Number() would
 * silently round a large NGN amount, and this codebase keeps money exact.
 */
const HAS_NONZERO_DIGIT = /[1-9]/

export const RecordPaymentSchema = z.object({
  saleId: z.string().min(1),
  amount: z.string().regex(AMOUNT_PATTERN, 'Enter a valid amount').refine(
    (v) => HAS_NONZERO_DIGIT.test(v),
    'Amount must be greater than zero'
  ),
  receivedAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date'),
  method: z.enum(['BANK_TRANSFER', 'MOBILE_MONEY', 'CASH', 'CHEQUE', 'OTHER']),
  reference: z.string().trim().max(80).optional(),
  note: z.string().trim().max(500).optional()
})

export type RecordPaymentInput = z.infer<typeof RecordPaymentSchema>

/**
 * Derives the sale's status from the entries as they actually stand after a
 * recompute, rather than assuming what a record or a void must have done.
 *
 * - CANCELLED is terminal here and is never overwritten. Voiding a payment on
 *   a cancelled sale used to resurrect it to ACTIVE; a cancellation is a
 *   business decision that a bookkeeping correction has no business undoing.
 * - Everything else is read off the schedule: settled everywhere -> COMPLETED,
 *   otherwise ACTIVE. That is what makes voiding a pure-overpayment payment
 *   (zero allocations, so nothing was recomputed) leave a COMPLETED sale
 *   COMPLETED instead of flipping it to ACTIVE while every entry is settled.
 *
 * Called while holding the sale's row lock, so the entries read here cannot be
 * moved out from under the decision.
 */
async function syncSaleStatus(
  tx: Prisma.TransactionClient,
  saleId: string,
  currentStatus: SaleStatus
): Promise<void> {
  if (currentStatus === 'CANCELLED') return

  const entries = await tx.scheduleEntry.findMany({
    where: { saleId },
    select: { amountDueMinor: true, amountPaidMinor: true }
  })

  const desired: SaleStatus = entries.every((e) => e.amountPaidMinor >= e.amountDueMinor)
    ? 'COMPLETED'
    : 'ACTIVE'

  if (desired !== currentStatus) {
    await tx.sale.update({ where: { id: saleId }, data: { status: desired } })
  }
}

export async function recordPayment(actor: SessionActor, input: RecordPaymentInput) {
  assertRole(actor, ['ADMIN', 'AGENT'])

  const sale = await prisma.sale.findFirst({
    where: { id: input.saleId, orgId: actor.orgId },
    select: { id: true, currency: true }
  })
  if (!sale) throw new ServiceError('Sale not found', 'NOT_FOUND')

  // The schema only checked numeric shape; currency-aware validation (e.g.
  // RWF has zero decimal places) needs the sale loaded above. Without this
  // the agent gets an uncaught 500 instead of being told what is wrong.
  let amountMinor: bigint
  try {
    amountMinor = toMinor(input.amount, sale.currency)
  } catch (error) {
    throw new ServiceError(error instanceof Error ? error.message : 'Invalid amount', 'VALIDATION')
  }

  const receivedAt = new Date(input.receivedAt)

  return prisma.$transaction(async (tx) => {
    // Before reading the schedule, not after: the read is what the second
    // writer would otherwise base a stale allocation on.
    await lockSale(tx, sale.id)

    // Status is re-read inside the lock. The findFirst above is only an
    // existence/org check; by the time the lock is held it could be stale.
    const locked = await tx.sale.findUniqueOrThrow({
      where: { id: sale.id },
      select: { status: true }
    })
    if (locked.status === 'CANCELLED') {
      // CONFLICT, not VALIDATION: the input is perfectly well-formed and the
      // actor is authorized. What is wrong is the state of the sale, and the
      // caller fixes it by reinstating the sale, not by editing the form.
      throw new ServiceError('That sale is cancelled — no payment can be recorded against it', 'CONFLICT')
    }

    const entries = await tx.scheduleEntry.findMany({
      where: { saleId: sale.id },
      orderBy: { sequence: 'asc' },
      select: { id: true, sequence: true, amountDueMinor: true, amountPaidMinor: true }
    })

    let allocations
    let overpaymentMinor: bigint
    try {
      ;({ allocations, overpaymentMinor } = allocatePayment(entries, amountMinor))
    } catch (error) {
      // AllocationError is a domain error about this request's money, not a
      // bug — surface it as a validation failure rather than a raw 500.
      if (error instanceof AllocationError) throw new ServiceError(error.message, 'VALIDATION')
      throw error
    }

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

    // `entries` carries every due amount applyAllocations needs, so it never
    // has to read one back.
    const settledEntryIds = await applyAllocations(tx, payment.id, allocations, receivedAt, entries)

    // Issued inside this same transaction, not after it commits: a payment
    // must never be able to exist without its receipt. This adds one
    // sequence claim (an `Organization` UPDATE) and one `Document` INSERT to
    // the transaction — negligible next to the allocation writes above, and
    // nowhere near the interactive-transaction timeout, so no override is
    // introduced here.
    const { documentId: receiptId } = await issueReceipt(tx, actor.orgId, sale.id, payment.id)

    await syncSaleStatus(tx, sale.id, locked.status)

    return { paymentId: payment.id, receiptId, overpaymentMinor, settledEntryIds }
  })
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

  await prisma.$transaction(async (tx) => {
    // Same lock as recordPayment, and for the same reason: a void and a
    // payment racing on one sale corrupt the cascade exactly as two payments
    // would. Both take the lock, so they queue instead of interleaving.
    await lockSale(tx, payment.saleId)

    const locked = await tx.sale.findUniqueOrThrow({
      where: { id: payment.saleId },
      select: { status: true }
    })

    // Re-read under the lock so a concurrent void cannot double-withdraw the
    // same allocations.
    const stillVoidable = await tx.payment.updateMany({
      where: { id: paymentId, voidedAt: null },
      data: { voidedAt: new Date(), voidedByUserId: actor.userId, voidReason: reason.trim() }
    })
    if (stillVoidable.count !== 1) {
      throw new ServiceError('That payment is already void', 'CONFLICT')
    }

    // The payment row survives for audit; only its allocations are
    // withdrawn. RESTRICT on PaymentAllocation -> Payment/ScheduleEntry
    // means allocations must go before the payment could ever be deleted;
    // here the payment itself is never deleted, only voided, so this
    // ordering just keeps the recompute below straightforward.
    await tx.paymentAllocation.deleteMany({ where: { paymentId } })

    // One batched read for the due amounts, then one batched recompute.
    const affectedEntries = await tx.scheduleEntry.findMany({
      where: { id: { in: affectedEntryIds } },
      select: { id: true, amountDueMinor: true }
    })

    // `undefined` means "leave paidAt unchanged" — see recomputeEntries for
    // why a still-covered entry keeps its original settlement date.
    await recomputeEntries(tx, affectedEntries, undefined)

    await syncSaleStatus(tx, payment.saleId, locked.status)
  })
}
