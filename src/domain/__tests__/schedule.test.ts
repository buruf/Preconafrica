import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERM_MONTHS,
  ScheduleError,
  generateSchedule,
  totalScheduledMinor
} from '@/domain/schedule'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
const iso = (d: Date) => d.toISOString().slice(0, 10)

const installments = (over: Partial<Parameters<typeof generateSchedule>[0]> = {}) =>
  generateSchedule({
    planType: 'INSTALLMENTS',
    priceMinor: 3_600_000n,
    depositMinor: 0n,
    months: 36,
    signedAt: utc(2026, 8, 9),
    ...over
  })

describe('generateSchedule — full payment', () => {
  it('produces exactly one entry due on the signing date', () => {
    const entries = generateSchedule({
      planType: 'FULL',
      priceMinor: 25_000_000_000n,
      depositMinor: 0n,
      months: 0,
      signedAt: utc(2026, 8, 9)
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].sequence).toBe(1)
    expect(entries[0].amountDueMinor).toBe(25_000_000_000n)
    expect(iso(entries[0].dueDate)).toBe('2026-08-09')
  })

  it('rejects a deposit on a full-payment sale', () => {
    expect(() =>
      generateSchedule({
        planType: 'FULL',
        priceMinor: 1000n,
        depositMinor: 100n,
        months: 0,
        signedAt: utc(2026, 8, 9)
      })
    ).toThrow(ScheduleError)
  })
})

describe('generateSchedule — even division', () => {
  it('produces identical installments when the amount divides evenly', () => {
    const entries = installments({ priceMinor: 3_600_000n, months: 36 })
    expect(entries).toHaveLength(36)
    for (const entry of entries) {
      expect(entry.amountDueMinor).toBe(100_000n)
    }
  })

  it('numbers entries from 1 without gaps', () => {
    const entries = installments()
    expect(entries.map((e) => e.sequence)).toEqual(
      Array.from({ length: 36 }, (_, i) => i + 1)
    )
  })

  it('defaults to a 36-month term constant', () => {
    expect(DEFAULT_TERM_MONTHS).toBe(36)
  })
})

describe('generateSchedule — remainder handling', () => {
  it('puts the entire remainder on the final installment', () => {
    // 100000 financed over 36 = 2777.77…; floor 2777, remainder 28
    const entries = installments({ priceMinor: 100_000n, months: 36 })

    for (const entry of entries.slice(0, 35)) {
      expect(entry.amountDueMinor).toBe(2_777n)
    }
    expect(entries[35].amountDueMinor).toBe(100_000n - 2_777n * 35n)
    expect(entries[35].amountDueMinor).toBe(2_805n)
  })

  it('subtracts the deposit before amortizing', () => {
    const entries = installments({
      priceMinor: 5_000_000n,
      depositMinor: 1_400_000n,
      months: 36
    })
    expect(totalScheduledMinor(entries)).toBe(3_600_000n)
    expect(entries[0].amountDueMinor).toBe(100_000n)
  })

  it('handles a term of exactly one month', () => {
    const entries = installments({ priceMinor: 999n, depositMinor: 99n, months: 1 })
    expect(entries).toHaveLength(1)
    expect(entries[0].amountDueMinor).toBe(900n)
  })

  it('handles a financed amount smaller than the term length', () => {
    // 10 minor units over 36 months: base floor is 0, last entry takes all 10.
    const entries = installments({ priceMinor: 10n, months: 36 })
    expect(entries.slice(0, 35).every((e) => e.amountDueMinor === 0n)).toBe(true)
    expect(entries[35].amountDueMinor).toBe(10n)
    expect(totalScheduledMinor(entries)).toBe(10n)
  })
})

describe('generateSchedule — the invariant', () => {
  it('always sums to exactly price minus deposit', () => {
    const prices = [100_000n, 3_600_001n, 25_000_000_000n, 999_999_999n, 7n, 1_250n]
    const deposits = [0n, 1n, 1_000n, 500_000n]
    const terms = [1, 2, 6, 12, 24, 36, 60, 120]

    for (const priceMinor of prices) {
      for (const depositMinor of deposits) {
        if (depositMinor >= priceMinor) continue
        for (const months of terms) {
          const entries = generateSchedule({
            planType: 'INSTALLMENTS',
            priceMinor,
            depositMinor,
            months,
            signedAt: utc(2026, 1, 31)
          })
          expect(
            totalScheduledMinor(entries),
            `price=${priceMinor} deposit=${depositMinor} months=${months}`
          ).toBe(priceMinor - depositMinor)
          expect(entries).toHaveLength(months)
        }
      }
    }
  })
})

describe('generateSchedule — due dates', () => {
  it('starts one month after signing, not on the signing date', () => {
    const entries = installments({ signedAt: utc(2026, 8, 9), months: 3 })
    expect(entries.map((e) => iso(e.dueDate))).toEqual([
      '2026-09-09',
      '2026-10-09',
      '2026-11-09'
    ])
  })

  it('clamps short months without degrading later dates', () => {
    const entries = installments({ signedAt: utc(2026, 1, 31), months: 4 })
    expect(entries.map((e) => iso(e.dueDate))).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31'
    ])
  })

  it('clamps into a leap February', () => {
    const entries = installments({ signedAt: utc(2028, 1, 31), months: 1 })
    expect(iso(entries[0].dueDate)).toBe('2028-02-29')
  })

  it('spans three year boundaries over a 36-month term', () => {
    const entries = installments({ signedAt: utc(2026, 8, 9), months: 36 })
    expect(iso(entries[0].dueDate)).toBe('2026-09-09')
    expect(iso(entries[35].dueDate)).toBe('2029-08-09')
  })

  it('normalises due dates to UTC midnight', () => {
    const entries = installments({
      signedAt: new Date('2026-08-09T19:22:03.101Z'),
      months: 1
    })
    expect(entries[0].dueDate.toISOString()).toBe('2026-09-09T00:00:00.000Z')
  })
})

describe('generateSchedule — rejected input', () => {
  const cases: Array<[string, Parameters<typeof generateSchedule>[0]]> = [
    ['deposit equal to price', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: 1000n, months: 12, signedAt: utc(2026, 8, 9) }],
    ['deposit greater than price', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: 1001n, months: 12, signedAt: utc(2026, 8, 9) }],
    ['negative deposit', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: -1n, months: 12, signedAt: utc(2026, 8, 9) }],
    ['zero price', { planType: 'INSTALLMENTS', priceMinor: 0n, depositMinor: 0n, months: 12, signedAt: utc(2026, 8, 9) }],
    ['negative price', { planType: 'INSTALLMENTS', priceMinor: -5n, depositMinor: 0n, months: 12, signedAt: utc(2026, 8, 9) }],
    ['zero months', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: 0n, months: 0, signedAt: utc(2026, 8, 9) }],
    ['negative months', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: 0n, months: -3, signedAt: utc(2026, 8, 9) }],
    ['fractional months', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: 0n, months: 12.5, signedAt: utc(2026, 8, 9) }],
    ['invalid signing date', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: 0n, months: 12, signedAt: new Date('nonsense') }]
  ]

  for (const [label, input] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => generateSchedule(input)).toThrow(ScheduleError)
    })
  }
})
