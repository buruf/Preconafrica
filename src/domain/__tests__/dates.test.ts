import { describe, expect, it } from 'vitest'
import { addMonthsClamped, differenceInDaysUtc, startOfUtcDay } from '@/domain/dates'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
const iso = (d: Date) => d.toISOString().slice(0, 10)

describe('startOfUtcDay', () => {
  it('zeroes the time component in UTC', () => {
    const result = startOfUtcDay(new Date('2026-03-15T23:47:11.512Z'))
    expect(result.toISOString()).toBe('2026-03-15T00:00:00.000Z')
  })
})

describe('addMonthsClamped', () => {
  it('adds whole months on a safe day-of-month', () => {
    expect(iso(addMonthsClamped(utc(2026, 1, 15), 1))).toBe('2026-02-15')
    expect(iso(addMonthsClamped(utc(2026, 1, 15), 12))).toBe('2027-01-15')
  })

  it('clamps Jan 31 to Feb 28 in a common year', () => {
    expect(iso(addMonthsClamped(utc(2026, 1, 31), 1))).toBe('2026-02-28')
  })

  it('clamps Jan 31 to Feb 29 in a leap year', () => {
    expect(iso(addMonthsClamped(utc(2028, 1, 31), 1))).toBe('2028-02-29')
  })

  it('restores the original day after a clamped month', () => {
    // The regression this guards: iterating month-by-month would give Mar 28.
    const signed = utc(2026, 1, 31)
    expect(iso(addMonthsClamped(signed, 1))).toBe('2026-02-28')
    expect(iso(addMonthsClamped(signed, 2))).toBe('2026-03-31')
    expect(iso(addMonthsClamped(signed, 3))).toBe('2026-04-30')
    expect(iso(addMonthsClamped(signed, 4))).toBe('2026-05-31')
  })

  it('never rolls forward into the following month', () => {
    for (let m = 1; m <= 36; m++) {
      const result = addMonthsClamped(utc(2026, 1, 31), m)
      const expectedMonth = (0 + m) % 12
      expect(result.getUTCMonth()).toBe(expectedMonth)
    }
  })

  it('crosses year boundaries across a 36-month term', () => {
    expect(iso(addMonthsClamped(utc(2026, 8, 9), 36))).toBe('2029-08-09')
  })

  it('handles month 0 as the start date itself', () => {
    expect(iso(addMonthsClamped(utc(2026, 8, 9), 0))).toBe('2026-08-09')
  })

  it('normalises the time component to UTC midnight', () => {
    const result = addMonthsClamped(new Date('2026-01-31T18:30:00.000Z'), 1)
    expect(result.toISOString()).toBe('2026-02-28T00:00:00.000Z')
  })
})

describe('differenceInDaysUtc', () => {
  it('counts whole days between dates', () => {
    expect(differenceInDaysUtc(utc(2026, 8, 9), utc(2026, 8, 2))).toBe(7)
  })

  it('returns 0 for the same day regardless of time', () => {
    expect(
      differenceInDaysUtc(new Date('2026-08-09T23:00:00Z'), new Date('2026-08-09T01:00:00Z'))
    ).toBe(0)
  })

  it('returns a negative count when the first date is earlier', () => {
    expect(differenceInDaysUtc(utc(2026, 8, 2), utc(2026, 8, 9))).toBe(-7)
  })

  it('is unaffected by daylight-saving transitions', () => {
    expect(differenceInDaysUtc(utc(2026, 4, 1), utc(2026, 3, 1))).toBe(31)
  })
})
