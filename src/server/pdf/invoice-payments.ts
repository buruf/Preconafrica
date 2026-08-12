/**
 * Turning an installment's allocations into the rows an invoice prints.
 *
 * Kept as a pure function, separate from both the Prisma query that feeds it
 * and the PDF that consumes it, for two reasons: the shaping has real rules
 * (which amount is the right one, what order rows appear in, what a missing
 * recorder prints as) and none of them are testable through a PDF buffer.
 */

/** What one row of the invoice's payments table needs. */
export interface InvoicePaymentRow {
  /**
   * What landed on *this* installment — `PaymentAllocation.amountMinor`, never
   * `Payment.amountMinor`. One payment routinely settles the tail of one
   * installment and the head of the next, so printing the payment's full amount
   * on both invoices would show a buyer paying twice what they paid.
   */
  amountMinor: bigint
  receivedAt: Date
  method: string
  reference: string | null
  /** The staff member's name, or `UNKNOWN_RECORDER` if the account is gone. */
  recordedBy: string
}

/**
 * Printed where the recorder's name cannot be resolved. `Payment.recordedByUserId`
 * is a plain column with no foreign key, so a deleted staff account leaves a
 * payment pointing at nobody — a real state, and not one worth failing a
 * buyer's invoice over. An em dash says "not known" without inventing a name.
 */
export const UNKNOWN_RECORDER = '—'

/** The shape the Prisma query hands over: an allocation with its payment. */
export interface AllocationWithPayment {
  amountMinor: bigint
  payment: {
    receivedAt: Date
    method: string
    reference: string | null
    recordedByUserId: string
  }
}

/**
 * Oldest payment first — the order the buyer paid in, which is the order they
 * remember. Sorted here rather than trusted from the caller's `orderBy`, so the
 * property holds for any caller and can be asserted without a database.
 *
 * `recorderNamesByUserId` is resolved by the caller in one batched query;
 * passing the lookup in rather than a fetch function keeps this synchronous and
 * makes the missing-name case a one-line test instead of a mocked round trip.
 */
export function buildInvoicePaymentRows(
  allocations: readonly AllocationWithPayment[],
  recorderNamesByUserId: ReadonlyMap<string, string>
): InvoicePaymentRow[] {
  return [...allocations]
    .sort((a, b) => a.payment.receivedAt.getTime() - b.payment.receivedAt.getTime())
    .map((allocation) => ({
      amountMinor: allocation.amountMinor,
      receivedAt: allocation.payment.receivedAt,
      method: allocation.payment.method,
      reference: allocation.payment.reference,
      // `|| UNKNOWN_RECORDER` rather than `??`: a user row that exists with a
      // blank name is as unprintable as no row at all.
      recordedBy:
        recorderNamesByUserId.get(allocation.payment.recordedByUserId)?.trim() || UNKNOWN_RECORDER
    }))
}
