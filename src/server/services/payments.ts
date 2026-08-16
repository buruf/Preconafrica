import type { Prisma, SaleStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { applyAllocations, lockSale, recomputeEntries } from '@/server/services/allocations'
import { issueReceipt } from '@/server/documents/issue'
import {
  allocateToEntry,
  AllocationError,
  EntrySettledError,
  OutstandingExceededError
} from '@/domain/allocation'
import { formatMinor, toMinor } from '@/domain/currency'
import { scheduleEntryTitle } from '@/domain/schedule'

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
  /**
   * Which schedule entry this payment settles — the deposit or one installment.
   * Required, with no default and no "apply it wherever it fits" mode: the
   * whole point of the targeted model is that a person decided where the money
   * lands, and a default is exactly how a duplicate deposit ends up spread
   * across thirteen installments nobody chose.
   */
  scheduleEntryId: z.string().min(1, 'Choose which payment this settles'),
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

    // The chosen entry, resolved *within this sale* — and the sale was already
    // resolved within the actor's organisation above. An id belonging to
    // another sale (or another org's sale) therefore matches nothing and comes
    // back NOT_FOUND, the same answer a nonexistent id gets, so a forged id can
    // neither be applied nor used to probe what exists. Read under the lock,
    // with the rest of the schedule, so the outstanding figure the cap is
    // computed from cannot move underneath the decision.
    const entry = await tx.scheduleEntry.findFirst({
      where: { id: input.scheduleEntryId, saleId: sale.id },
      select: { id: true, sequence: true, amountDueMinor: true, amountPaidMinor: true }
    })
    if (!entry) throw new ServiceError('That payment schedule entry was not found', 'NOT_FOUND')

    let allocation
    try {
      ;({ allocation } = allocateToEntry(entry, amountMinor))
    } catch (error) {
      // AllocationError is a domain error about this request's money, not a
      // bug — surface it as a validation failure rather than a raw 500. The
      // two the agent can act on are spelled out with the figures they need:
      // the domain knows the minor units, this layer knows the currency.
      if (error instanceof OutstandingExceededError) {
        throw new ServiceError(
          `${scheduleEntryTitle(entry.sequence)} has ${formatMinor(error.outstandingMinor, sale.currency)} outstanding — enter that amount or less.`,
          'VALIDATION'
        )
      }
      if (error instanceof EntrySettledError) {
        throw new ServiceError(
          `${scheduleEntryTitle(entry.sequence)} is already fully paid — choose an entry that still owes something.`,
          'VALIDATION'
        )
      }
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

    // Exactly one allocation, against the one entry that was chosen — and that
    // entry carries the due amount applyAllocations needs, so it never has to
    // read one back.
    const settledEntryIds = await applyAllocations(tx, payment.id, [allocation], receivedAt, [entry])

    // Issued inside this same transaction, not after it commits: a payment
    // must never be able to exist without its receipt. This adds one
    // sequence claim (an `Organization` UPDATE) and one `Document` INSERT to
    // the transaction — negligible next to the allocation writes above, and
    // nowhere near the interactive-transaction timeout, so no override is
    // introduced here.
    const { documentId: receiptId, number: receiptNumber } = await issueReceipt(
      tx,
      actor.orgId,
      sale.id,
      payment.id
    )

    await syncSaleStatus(tx, sale.id, locked.status)

    // `overpaymentMinor` is gone rather than returned as a permanent zero: the
    // amount is capped at one entry's outstanding, so a surplus cannot occur,
    // and a field that is always zero is a trap for the next reader.
    //
    // What replaces it is what the confirmation needs — the figure, where it
    // landed, and the receipt it produced — returned from here rather than
    // re-queried by the caller, because all three are known inside this
    // transaction and none of them may be trusted from the client.
    return {
      paymentId: payment.id,
      receiptId,
      receiptNumber,
      amountMinor,
      currency: sale.currency,
      entrySequence: entry.sequence,
      settledEntryIds
    }
  })
}

export async function voidPayment(actor: SessionActor, paymentId: string, reason: string) {
  // Voiding rewrites balances, so it is ADMIN-only.
  assertRole(actor, ['ADMIN'])
  if (!reason.trim()) throw new ServiceError('A reason is required to void a payment')

  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, orgId: actor.orgId },
    include: {
      // The sequences come along so the confirmation can name what has just
      // gone back to being outstanding. Under the targeted model that is
      // always exactly one entry; a payment recorded under the old cascade
      // still carries several, and both are described truthfully.
      allocations: { select: { scheduleEntryId: true, scheduleEntry: { select: { sequence: true } } } },
      sale: { select: { currency: true } }
    }
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
    //
    // This is the whole of a void under the targeted model, and it is the
    // same three statements it always was: withdraw the allocations, recompute
    // the entries they touched from the rows that survive, re-derive the sale's
    // status. There is nothing to re-cascade — the money never flowed past the
    // one entry it was recorded against, so no *other* entry's balance can
    // depend on this payment. The reconciliation invariant holds for the same
    // reason it always did: every entry's amountPaidMinor is recomputed from
    // its surviving allocations rather than decremented, so it agrees with the
    // audit trail whatever the payment happened to touch.
    await recomputeEntries(tx, affectedEntries, undefined)

    await syncSaleStatus(tx, payment.saleId, locked.status)
  })

  return {
    amountMinor: payment.amountMinor,
    currency: payment.sale.currency,
    // Ascending, so "installments 1 and 2" reads in schedule order rather than
    // in whatever order the allocation rows came back.
    entrySequences: payment.allocations
      .map((a) => a.scheduleEntry.sequence)
      .sort((a, b) => a - b)
  }
}
