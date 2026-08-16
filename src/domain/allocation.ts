/**
 * How money is applied to a payment schedule.
 *
 * There is one rule and it is `allocateToEntry` below: a payment settles the
 * one entry the person recording it chose, capped at what that entry still
 * owes. The oldest-first cascade this module used to hold — one payment
 * flowing forward across as many entries as its size reached — is gone, along
 * with the surplus figure only a cascade could produce. See `allocateToEntry`
 * for why.
 */

export interface AllocatableEntry {
  id: string
  sequence: number
  amountDueMinor: bigint
  amountPaidMinor: bigint
}

export interface Allocation {
  entryId: string
  amountMinor: bigint
}

export class AllocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllocationError'
  }
}

/**
 * The chosen entry owes nothing, so nothing can be recorded against it. A
 * distinct type rather than a message to match on: the caller's remedy is
 * "pick another entry", which is different advice from "type a smaller
 * figure", and the two must not be told apart by string comparison.
 */
export class EntrySettledError extends AllocationError {
  constructor(entryId: string) {
    super(`entry ${entryId} is already fully paid`)
    this.name = 'EntrySettledError'
  }
}

/**
 * The amount is larger than the chosen entry still owes.
 *
 * `outstandingMinor` travels on the error because the figure the agent needs
 * ("type this instead") is known here and nowhere else — and it cannot be
 * formatted here, since a pure money function has no business knowing which
 * currency a sale is denominated in. The service layer, which does, turns this
 * into the sentence a person reads.
 */
export class OutstandingExceededError extends AllocationError {
  constructor(
    readonly entryId: string,
    readonly outstandingMinor: bigint,
    readonly amountMinor: bigint
  ) {
    super(
      `payment of ${amountMinor} exceeds the ${outstandingMinor} minor units entry ${entryId} still owes`
    )
    this.name = 'OutstandingExceededError'
  }
}

export interface TargetedAllocationResult {
  /** Exactly one. A payment never spreads. */
  allocation: Allocation
  /** What the entry owed before this payment. */
  outstandingBeforeMinor: bigint
  /** Zero when this payment settles the entry; positive leaves it PARTIAL. */
  outstandingAfterMinor: bigint
}

/**
 * Applies a payment to the one schedule entry the person recording it chose.
 *
 * This is the rule the platform actually works by, and it replaces the
 * oldest-first cascade for every new recording. The cascade was arithmetically
 * exact — a duplicate deposit reconciled to the last minor unit — but it spread
 * one $50,000 deposit across thirteen installments, and the developer reading
 * that schedule could not tell a correct system from an invented-money one. A
 * payment that lands where the agent said it lands is legible; a payment that
 * lands in thirteen places is a reconciliation exercise.
 *
 * Two consequences follow and both are deliberate. Overpayment ceases to exist:
 * the amount is capped at what this one entry owes, so there is no surplus to
 * report, absorb or lose. And voiding becomes trivial: one payment touches one
 * entry, so withdrawing it affects that entry alone with nothing to re-cascade.
 *
 * Any unpaid entry is a legal target, not only the oldest — a buyer paying
 * installment 5 early is not blocked because 4 is outstanding. Ordering is the
 * schedule's business, not this function's.
 *
 * Pure: the entry is never mutated, so the caller decides how the single
 * allocation is persisted.
 */
export function allocateToEntry(
  entry: AllocatableEntry,
  amountMinor: bigint
): TargetedAllocationResult {
  if (amountMinor <= 0n) {
    throw new AllocationError('payment amount must be greater than zero')
  }

  if (entry.amountPaidMinor > entry.amountDueMinor) {
    throw new AllocationError(
      `entry ${entry.id} is already over-allocated (${entry.amountPaidMinor} of ${entry.amountDueMinor})`
    )
  }

  const outstandingBeforeMinor = entry.amountDueMinor - entry.amountPaidMinor
  if (outstandingBeforeMinor === 0n) throw new EntrySettledError(entry.id)

  if (amountMinor > outstandingBeforeMinor) {
    throw new OutstandingExceededError(entry.id, outstandingBeforeMinor, amountMinor)
  }

  return {
    allocation: { entryId: entry.id, amountMinor },
    outstandingBeforeMinor,
    outstandingAfterMinor: outstandingBeforeMinor - amountMinor
  }
}
