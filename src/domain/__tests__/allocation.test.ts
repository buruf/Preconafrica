import { describe, expect, it } from 'vitest'
import {
  allocateToEntry,
  AllocationError,
  EntrySettledError,
  OutstandingExceededError,
  type AllocatableEntry
} from '@/domain/allocation'

const entry = (
  sequence: number,
  amountDueMinor: bigint,
  amountPaidMinor = 0n
): AllocatableEntry => ({
  id: `e${sequence}`,
  sequence,
  amountDueMinor,
  amountPaidMinor
})

/**
 * The rule the platform records money by, in one function: a payment settles
 * the one entry it was aimed at, capped at what that entry still owes.
 *
 * These replace the cascade tests that used to live here. The cascade was not
 * wrong arithmetically — it reconciled exactly — but it spread a single payment
 * across as many entries as its size reached, and a duplicate $50,000 deposit
 * landing in thirteen places is indistinguishable, to the developer reading the
 * schedule, from a system inventing money. The coverage is kept and rewritten
 * to the rule that replaced it, rather than dropped.
 */
describe('allocateToEntry', () => {
  it('settles the chosen entry with an exact payment', () => {
    const result = allocateToEntry(entry(1, 300n), 300n)
    expect(result.allocation).toEqual({ entryId: 'e1', amountMinor: 300n })
    expect(result.outstandingBeforeMinor).toBe(300n)
    expect(result.outstandingAfterMinor).toBe(0n)
  })

  it('leaves the entry partial when the payment is short', () => {
    const result = allocateToEntry(entry(1, 300n), 120n)
    expect(result.allocation).toEqual({ entryId: 'e1', amountMinor: 120n })
    expect(result.outstandingAfterMinor).toBe(180n)
  })

  it('tops up an already-partial entry, and only up to what is left', () => {
    const result = allocateToEntry(entry(1, 300n, 250n), 50n)
    expect(result.allocation).toEqual({ entryId: 'e1', amountMinor: 50n })
    expect(result.outstandingBeforeMinor).toBe(50n)
    expect(result.outstandingAfterMinor).toBe(0n)
  })

  it('refuses an amount above what the entry still owes, and says how much that is', () => {
    // 300 due, 250 already paid: 50 is the ceiling, and 60 is refused rather
    // than applied-and-cascaded. This is the whole change — under the old rule
    // the extra 10 flowed to the next entry nobody chose.
    const failure = (() => {
      try {
        allocateToEntry(entry(1, 300n, 250n), 60n)
      } catch (error) {
        return error
      }
    })()

    expect(failure).toBeInstanceOf(OutstandingExceededError)
    expect(failure).toBeInstanceOf(AllocationError)
    // The figure travels on the error, because the layer that can format it
    // into a sentence for the agent is not this one.
    expect((failure as OutstandingExceededError).outstandingMinor).toBe(50n)
    expect((failure as OutstandingExceededError).amountMinor).toBe(60n)
    expect((failure as OutstandingExceededError).entryId).toBe('e1')
  })

  it('refuses an entry that is already fully paid', () => {
    const failure = (() => {
      try {
        allocateToEntry(entry(1, 300n, 300n), 50n)
      } catch (error) {
        return error
      }
    })()

    // A distinct type from the over-outstanding one: the remedy is "choose
    // another entry", not "type a smaller figure".
    expect(failure).toBeInstanceOf(EntrySettledError)
    expect(failure).not.toBeInstanceOf(OutstandingExceededError)
  })

  it('rejects a non-positive payment', () => {
    expect(() => allocateToEntry(entry(1, 300n), 0n)).toThrow(AllocationError)
    expect(() => allocateToEntry(entry(1, 300n), -5n)).toThrow(AllocationError)
  })

  it('rejects an entry already paid beyond its due amount', () => {
    // Unreachable through the services, which cap every payment — but a
    // hand-repaired row could be in this state, and allocating against it
    // would compute a negative outstanding and accept anything at all.
    expect(() => allocateToEntry(entry(1, 300n, 400n), 10n)).toThrow(AllocationError)
  })

  it('does not care whether earlier entries are outstanding', () => {
    // Installment 5, chosen deliberately while 1-4 are unpaid. Ordering is the
    // schedule's business; a buyer paying ahead is not blocked by arrears.
    const result = allocateToEntry(entry(5, 300n), 300n)
    expect(result.allocation).toEqual({ entryId: 'e5', amountMinor: 300n })
  })

  it('handles amounts far beyond Int32', () => {
    const result = allocateToEntry(entry(1, 25_000_000_000n), 25_000_000_000n)
    expect(result.allocation.amountMinor).toBe(25_000_000_000n)
  })

  it('does not mutate the entry it was given', () => {
    const target = entry(1, 300n, 100n)
    allocateToEntry(target, 200n)
    expect(target.amountPaidMinor).toBe(100n)
    expect(target.amountDueMinor).toBe(300n)
  })

  it('never emits a zero-amount allocation', () => {
    // The only way to reach zero would be a zero payment, which is refused
    // above — so every allocation this function returns moves money.
    const result = allocateToEntry(entry(1, 300n), 1n)
    expect(result.allocation.amountMinor).toBeGreaterThan(0n)
  })
})
