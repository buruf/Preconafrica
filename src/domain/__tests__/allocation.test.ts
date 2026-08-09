import { describe, expect, it } from 'vitest'
import { AllocationError, allocatePayment, type AllocatableEntry } from '@/domain/allocation'

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

const threeEntries = () => [entry(1, 300n), entry(2, 300n), entry(3, 300n)]

describe('allocatePayment', () => {
  it('settles a single entry with an exact payment', () => {
    const result = allocatePayment(threeEntries(), 300n)
    expect(result.allocations).toEqual([{ entryId: 'e1', amountMinor: 300n }])
    expect(result.appliedMinor).toBe(300n)
    expect(result.overpaymentMinor).toBe(0n)
  })

  it('leaves an entry partial when the payment is short', () => {
    const result = allocatePayment(threeEntries(), 120n)
    expect(result.allocations).toEqual([{ entryId: 'e1', amountMinor: 120n }])
    expect(result.overpaymentMinor).toBe(0n)
  })

  it('cascades a large payment across three entries', () => {
    const result = allocatePayment(threeEntries(), 900n)
    expect(result.allocations).toEqual([
      { entryId: 'e1', amountMinor: 300n },
      { entryId: 'e2', amountMinor: 300n },
      { entryId: 'e3', amountMinor: 300n }
    ])
    expect(result.overpaymentMinor).toBe(0n)
  })

  it('cascades and leaves the last touched entry partial', () => {
    const result = allocatePayment(threeEntries(), 700n)
    expect(result.allocations).toEqual([
      { entryId: 'e1', amountMinor: 300n },
      { entryId: 'e2', amountMinor: 300n },
      { entryId: 'e3', amountMinor: 100n }
    ])
  })

  it('tops up an already-partial entry before moving on', () => {
    const entries = [entry(1, 300n, 250n), entry(2, 300n)]
    const result = allocatePayment(entries, 100n)
    expect(result.allocations).toEqual([
      { entryId: 'e1', amountMinor: 50n },
      { entryId: 'e2', amountMinor: 50n }
    ])
  })

  it('skips fully paid entries', () => {
    const entries = [entry(1, 300n, 300n), entry(2, 300n)]
    const result = allocatePayment(entries, 300n)
    expect(result.allocations).toEqual([{ entryId: 'e2', amountMinor: 300n }])
  })

  it('reports surplus beyond the final entry rather than discarding it', () => {
    const result = allocatePayment(threeEntries(), 1_000n)
    expect(result.appliedMinor).toBe(900n)
    expect(result.overpaymentMinor).toBe(100n)
    expect(result.allocations).toHaveLength(3)
  })

  it('reports the whole payment as overpayment when nothing is outstanding', () => {
    const entries = [entry(1, 300n, 300n)]
    const result = allocatePayment(entries, 50n)
    expect(result.allocations).toEqual([])
    expect(result.appliedMinor).toBe(0n)
    expect(result.overpaymentMinor).toBe(50n)
  })

  it('orders by sequence regardless of input order', () => {
    const result = allocatePayment([entry(3, 300n), entry(1, 300n), entry(2, 300n)], 400n)
    expect(result.allocations).toEqual([
      { entryId: 'e1', amountMinor: 300n },
      { entryId: 'e2', amountMinor: 100n }
    ])
  })

  it('never emits a zero-amount allocation', () => {
    const result = allocatePayment(threeEntries(), 600n)
    expect(result.allocations.every((a) => a.amountMinor > 0n)).toBe(true)
    expect(result.allocations).toHaveLength(2)
  })

  it('handles amounts far beyond Int32', () => {
    const result = allocatePayment([entry(1, 25_000_000_000n)], 25_000_000_000n)
    expect(result.allocations[0].amountMinor).toBe(25_000_000_000n)
  })

  it('rejects a non-positive payment', () => {
    expect(() => allocatePayment(threeEntries(), 0n)).toThrow(AllocationError)
    expect(() => allocatePayment(threeEntries(), -5n)).toThrow(AllocationError)
  })

  it('rejects an entry overpaid beyond its due amount', () => {
    expect(() => allocatePayment([entry(1, 300n, 400n)], 10n)).toThrow(AllocationError)
  })

  it('does not mutate the input entries', () => {
    const entries = threeEntries()
    allocatePayment(entries, 900n)
    expect(entries.map((e) => e.amountPaidMinor)).toEqual([0n, 0n, 0n])
  })
})
