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

export interface AllocationResult {
  allocations: Allocation[]
  /** Total actually applied to entries. */
  appliedMinor: bigint
  /** Surplus that no entry could absorb. Returned, never silently dropped. */
  overpaymentMinor: bigint
}

export class AllocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllocationError'
  }
}

/**
 * Applies a payment to the oldest unpaid entry first, cascading any excess
 * forward. Pure: the input entries are never mutated, so the caller decides
 * how the result is persisted.
 */
export function allocatePayment(
  entries: AllocatableEntry[],
  amountMinor: bigint
): AllocationResult {
  if (amountMinor <= 0n) {
    throw new AllocationError('payment amount must be greater than zero')
  }

  for (const entry of entries) {
    if (entry.amountPaidMinor > entry.amountDueMinor) {
      throw new AllocationError(
        `entry ${entry.id} is already over-allocated (${entry.amountPaidMinor} of ${entry.amountDueMinor})`
      )
    }
  }

  const ordered = [...entries].sort((a, b) => a.sequence - b.sequence)
  const allocations: Allocation[] = []
  let remaining = amountMinor

  for (const entry of ordered) {
    if (remaining === 0n) break

    const outstanding = entry.amountDueMinor - entry.amountPaidMinor
    if (outstanding <= 0n) continue

    const applied = remaining < outstanding ? remaining : outstanding
    allocations.push({ entryId: entry.id, amountMinor: applied })
    remaining -= applied
  }

  return {
    allocations,
    appliedMinor: amountMinor - remaining,
    overpaymentMinor: remaining
  }
}
