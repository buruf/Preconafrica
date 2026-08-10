import { describe, expect, it } from 'vitest'
import { daysLate, deriveStatus, outstandingMinor } from '@/domain/status'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
const DUE = utc(2026, 8, 9)

const at = (amountPaidMinor: bigint, dueDate = DUE) => ({
  dueDate,
  amountDueMinor: 300n,
  amountPaidMinor
})

describe('deriveStatus', () => {
  it('is PAID when the full amount is settled', () => {
    expect(deriveStatus(at(300n), utc(2026, 12, 1))).toBe('PAID')
  })

  it('stays PAID even long after the due date', () => {
    expect(deriveStatus(at(300n), utc(2030, 1, 1))).toBe('PAID')
  })

  it('is PENDING when unpaid and the due date is in the future', () => {
    expect(deriveStatus(at(0n), utc(2026, 8, 1))).toBe('PENDING')
  })

  it('is not yet OVERDUE on the due date itself', () => {
    expect(deriveStatus(at(0n), DUE)).toBe('PENDING')
  })

  it('is not yet OVERDUE late in the evening of the due date', () => {
    expect(deriveStatus(at(0n), new Date('2026-08-09T23:59:00Z'))).toBe('PENDING')
  })

  it('is OVERDUE the day after the due date', () => {
    expect(deriveStatus(at(0n), utc(2026, 8, 10))).toBe('OVERDUE')
  })

  it('is PARTIAL when part-paid and not yet due', () => {
    expect(deriveStatus(at(100n), utc(2026, 8, 1))).toBe('PARTIAL')
  })

  it('is OVERDUE rather than PARTIAL when part-paid and past due', () => {
    expect(deriveStatus(at(100n), utc(2026, 9, 1))).toBe('OVERDUE')
  })

  it('treats a zero-amount entry as PAID', () => {
    expect(
      deriveStatus({ dueDate: DUE, amountDueMinor: 0n, amountPaidMinor: 0n }, utc(2030, 1, 1))
    ).toBe('PAID')
  })
})

describe('daysLate', () => {
  it('returns 0 for an entry that is not overdue', () => {
    expect(daysLate(at(0n), utc(2026, 8, 1))).toBe(0)
    expect(daysLate(at(0n), DUE)).toBe(0)
  })

  it('counts whole days past the due date', () => {
    expect(daysLate(at(0n), utc(2026, 8, 20))).toBe(11)
  })

  it('returns 0 once the entry is fully paid', () => {
    expect(daysLate(at(300n), utc(2026, 12, 1))).toBe(0)
  })

  it('counts lateness for a part-paid entry', () => {
    expect(daysLate(at(100n), utc(2026, 8, 20))).toBe(11)
  })
})

describe('outstandingMinor', () => {
  it('returns the unpaid remainder', () => {
    expect(outstandingMinor(at(120n))).toBe(180n)
  })

  it('never returns a negative figure', () => {
    expect(outstandingMinor(at(400n))).toBe(0n)
  })
})
