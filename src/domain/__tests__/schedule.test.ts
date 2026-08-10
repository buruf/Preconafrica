import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERM_MONTHS,
  DEPOSIT_SEQUENCE,
  MAX_MARKUP_BPS,
  ScheduleError,
  computeMarkupMinor,
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
    markupBps: 0,
    months: 36,
    signedAt: utc(2026, 8, 9),
    ...over
  })

const full = (over: Partial<Parameters<typeof generateSchedule>[0]> = {}) =>
  generateSchedule({
    planType: 'FULL',
    priceMinor: 1_000n,
    depositMinor: 0n,
    markupBps: 0,
    months: 0,
    signedAt: utc(2026, 8, 9),
    ...over
  })

describe('generateSchedule — full payment', () => {
  it('produces exactly one entry due on the signing date', () => {
    const entries = full({ priceMinor: 25_000_000_000n })

    expect(entries).toHaveLength(1)
    expect(entries[0].sequence).toBe(1)
    expect(entries[0].amountDueMinor).toBe(25_000_000_000n)
    expect(iso(entries[0].dueDate)).toBe('2026-08-09')
  })

  it('rejects a deposit on a full-payment sale', () => {
    expect(() => full({ depositMinor: 100n })).toThrow(ScheduleError)
  })

  it('rejects an installment markup on a full-payment sale', () => {
    // Nothing is financed, so there is nothing to charge for. A project default
    // that leaked onto a FULL plan must fail loudly rather than be ignored —
    // ignoring it means the schedule and whatever the UI quoted disagree.
    expect(() => full({ markupBps: 1_000 })).toThrow(ScheduleError)
    expect(() => full({ markupBps: 1 })).toThrow(ScheduleError)
    expect(() => full({ markupBps: 1_000 })).toThrow(/markup/i)
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

  it('subtracts the deposit before amortizing the monthly installments', () => {
    const entries = installments({
      priceMinor: 5_000_000n,
      depositMinor: 1_400_000n,
      months: 36
    })
    // The deposit is now an entry of its own, so the schedule totals the whole
    // price — but only the financed 3,600,000 is spread across the 36 months.
    expect(totalScheduledMinor(entries)).toBe(5_000_000n)
    expect(entries).toHaveLength(37)
    expect(entries[0].amountDueMinor).toBe(1_400_000n)
    for (const entry of entries.slice(1)) {
      expect(entry.amountDueMinor).toBe(100_000n)
    }
  })

  it('handles a term of exactly one month', () => {
    const entries = installments({ priceMinor: 999n, depositMinor: 99n, months: 1 })
    expect(entries).toHaveLength(2)
    expect(entries[0].amountDueMinor).toBe(99n)
    expect(entries[1].amountDueMinor).toBe(900n)
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
  it('always sums to exactly the price plus the markup', () => {
    const prices = [100_000n, 3_600_001n, 25_000_000_000n, 999_999_999n, 7n, 1_250n]
    const deposits = [0n, 1n, 1_000n, 500_000n]
    const terms = [1, 2, 6, 12, 24, 36, 60, 120]
    // 0 proves the markup is genuinely optional; 500 and 1000 are the rates a
    // developer would actually charge; 3333 is deliberately awful — it divides
    // evenly into nothing, so every rounding step has a remainder to lose.
    const markups = [0, 500, 1_000, 3_333]

    for (const priceMinor of prices) {
      for (const depositMinor of deposits) {
        if (depositMinor >= priceMinor) continue
        for (const markupBps of markups) {
          for (const months of terms) {
            const label = `price=${priceMinor} deposit=${depositMinor} markup=${markupBps}bps months=${months}`
            const entries = generateSchedule({
              planType: 'INSTALLMENTS',
              priceMinor,
              depositMinor,
              markupBps,
              months,
              signedAt: utc(2026, 1, 31)
            })

            // The whole contract is in the schedule: nothing about this sale is
            // owed that is not one of these entries, and nothing is double
            // counted. This is the one assertion every other money figure in
            // the platform — balance, arrears, statement total — rests on.
            const markupMinor = computeMarkupMinor(priceMinor - depositMinor, markupBps)
            expect(totalScheduledMinor(entries), label).toBe(priceMinor + markupMinor)
            expect(entries, label).toHaveLength(depositMinor > 0n ? months + 1 : months)

            // The deposit is never marked up — only the financed part is — so
            // the months carry exactly the financed amount plus the charge.
            const monthly = entries.filter((e) => e.sequence !== DEPOSIT_SEQUENCE)
            expect(totalScheduledMinor(monthly), label).toBe(
              priceMinor - depositMinor + markupMinor
            )
            expect(monthly, label).toHaveLength(months)

            // No entry is ever negative: a floor-divided base plus a remainder
            // absorbed by the last installment can never produce one, and a
            // negative amount due would break allocation and every total.
            for (const entry of entries) {
              expect(entry.amountDueMinor >= 0n, `${label} seq=${entry.sequence}`).toBe(true)
            }
          }
        }
      }
    }
  })

  it('reduces to the price when nothing is marked up', () => {
    // The pre-markup contract, still intact: a 0 bps installment plan and a
    // full-payment sale both total exactly the price.
    const zeroMarkup = installments({ priceMinor: 5_000_000n, depositMinor: 1_400_000n })
    expect(totalScheduledMinor(zeroMarkup)).toBe(5_000_000n)
    expect(totalScheduledMinor(full({ priceMinor: 25_000_000_000n }))).toBe(25_000_000_000n)
  })
})

describe('generateSchedule — the deposit entry', () => {
  it('leads the schedule and is due on the signing day', () => {
    const entries = installments({
      priceMinor: 5_000_000n,
      depositMinor: 1_400_000n,
      months: 36,
      signedAt: utc(2026, 8, 9)
    })

    expect(entries[0].sequence).toBe(DEPOSIT_SEQUENCE)
    expect(entries[0].sequence).toBe(0)
    expect(entries[0].amountDueMinor).toBe(1_400_000n)
    expect(iso(entries[0].dueDate)).toBe('2026-08-09')
    // The very first thing owed, not something bolted on at the end.
    expect(entries.findIndex((e) => e.sequence === DEPOSIT_SEQUENCE)).toBe(0)
  })

  it('normalises the deposit due date to UTC midnight', () => {
    const entries = installments({
      priceMinor: 1_000n,
      depositMinor: 100n,
      months: 1,
      signedAt: new Date('2026-08-09T19:22:03.101Z')
    })
    expect(entries[0].dueDate.toISOString()).toBe('2026-08-09T00:00:00.000Z')
  })

  it('leaves the monthly installments numbered 1..months', () => {
    const entries = installments({ priceMinor: 5_000_000n, depositMinor: 1_400_000n, months: 36 })
    expect(entries.map((e) => e.sequence)).toEqual(
      Array.from({ length: 37 }, (_, i) => i)
    )
  })

  it('produces no sequence 0 when there is no deposit', () => {
    const entries = installments({ depositMinor: 0n, months: 36 })
    expect(entries).toHaveLength(36)
    expect(entries.some((e) => e.sequence === DEPOSIT_SEQUENCE)).toBe(false)
    expect(entries[0].sequence).toBe(1)
  })

  it('leaves a full-payment schedule as a single sequence-1 entry', () => {
    const entries = full()
    expect(entries).toHaveLength(1)
    expect(entries[0].sequence).toBe(1)
    expect(entries.some((e) => e.sequence === DEPOSIT_SEQUENCE)).toBe(false)
  })

  it('does not shift the monthly due dates', () => {
    const withDeposit = installments({
      priceMinor: 5_000_000n,
      depositMinor: 1_400_000n,
      months: 3,
      signedAt: utc(2026, 8, 9)
    })
    expect(withDeposit.map((e) => iso(e.dueDate))).toEqual([
      '2026-08-09',
      '2026-09-09',
      '2026-10-09',
      '2026-11-09'
    ])
  })
})

describe('computeMarkupMinor', () => {
  it('reads basis points as hundredths of a percent', () => {
    expect(computeMarkupMinor(10_000_000n, 1_000)).toBe(1_000_000n) // 10%
    expect(computeMarkupMinor(10_000_000n, 500)).toBe(500_000n) // 5%
    expect(computeMarkupMinor(10_000_000n, 1)).toBe(1_000n) // 0.01%
    expect(computeMarkupMinor(10_000_000n, MAX_MARKUP_BPS)).toBe(10_000_000n) // 100%
  })

  it('charges nothing at zero basis points', () => {
    expect(computeMarkupMinor(999_999_999n, 0)).toBe(0n)
    expect(computeMarkupMinor(0n, 0)).toBe(0n)
  })

  it('floors the fraction of a minor unit in the buyer’s favour', () => {
    // 9,000,001 at 33.33% is 2,999,700.3333 — the buyer is charged 2,999,700.
    expect(computeMarkupMinor(9_000_001n, 3_333)).toBe(2_999_700n)
    // Under a full minor unit of charge rounds away entirely rather than up.
    expect(computeMarkupMinor(1n, 500)).toBe(0n)
    expect(computeMarkupMinor(199n, 500)).toBe(9n)
  })

  it('stays exact at a scale that would break a float', () => {
    // 0.1 has no exact binary representation, so `financed * 0.1` on a number
    // this large loses minor units. In BigInt with basis points it cannot.
    expect(computeMarkupMinor(25_000_000_000_000n, 1_000)).toBe(2_500_000_000_000n)
  })

  it('rejects a markup outside 0–100%', () => {
    expect(() => computeMarkupMinor(1_000n, -1)).toThrow(ScheduleError)
    expect(() => computeMarkupMinor(1_000n, MAX_MARKUP_BPS + 1)).toThrow(ScheduleError)
    expect(() => computeMarkupMinor(1_000n, 12.5)).toThrow(ScheduleError)
  })
})

describe('generateSchedule — the installment markup', () => {
  it('amortizes the marked-up financed amount, hand-checked', () => {
    // Price 10,000,000, deposit 1,000,000, 10% over 36 months:
    //   financed 9,000,000 → markup 900,000 → charged 9,900,000
    //   9,900,000 / 36 = 275,000 exactly, so every month is identical.
    const entries = installments({
      priceMinor: 10_000_000n,
      depositMinor: 1_000_000n,
      markupBps: 1_000,
      months: 36
    })

    expect(entries).toHaveLength(37)
    expect(entries[0].amountDueMinor).toBe(1_000_000n) // the deposit, unmarked
    for (const entry of entries.slice(1)) {
      expect(entry.amountDueMinor).toBe(275_000n)
    }
    expect(totalScheduledMinor(entries)).toBe(10_900_000n)
    expect(totalScheduledMinor(entries)).toBe(10_000_000n + 900_000n)
  })

  it('puts the marked-up remainder on the final installment, hand-checked', () => {
    // Price 10,000,001, deposit 1,000,000, 33.33% over 36 months:
    //   financed 9,000,001 → markup 2,999,700 (floored from .3333)
    //   charged 11,999,701 → 333,325 a month, 333,326 last (11,999,701 − 35×333,325)
    const entries = installments({
      priceMinor: 10_000_001n,
      depositMinor: 1_000_000n,
      markupBps: 3_333,
      months: 36
    })

    expect(entries[0].amountDueMinor).toBe(1_000_000n)
    for (const entry of entries.slice(1, 36)) {
      expect(entry.amountDueMinor).toBe(333_325n)
    }
    expect(entries[36].amountDueMinor).toBe(333_326n)
    expect(totalScheduledMinor(entries)).toBe(12_999_701n)
    expect(totalScheduledMinor(entries)).toBe(10_000_001n + 2_999_700n)
  })

  it('charges the markup on the financed amount, not on the price', () => {
    // The same price and rate, three deposits. A bigger deposit finances less,
    // so it costs the buyer less — the whole reason the basis is the financed
    // amount. If the markup were charged on the price, these would be equal.
    const charge = (depositMinor: bigint) =>
      totalScheduledMinor(
        installments({ priceMinor: 10_000_000n, depositMinor, markupBps: 1_000, months: 36 })
      ) - 10_000_000n

    expect(charge(0n)).toBe(1_000_000n)
    expect(charge(1_000_000n)).toBe(900_000n)
    expect(charge(9_000_000n)).toBe(100_000n)
  })

  it('leaves the schedule untouched at zero basis points', () => {
    const marked = installments({ priceMinor: 5_000_000n, depositMinor: 1_400_000n, markupBps: 0 })
    expect(totalScheduledMinor(marked)).toBe(5_000_000n)
    for (const entry of marked.slice(1)) {
      expect(entry.amountDueMinor).toBe(100_000n)
    }
  })

  it('handles a 100% markup', () => {
    // Price 1,000, deposit 100, financed 900, doubled to 1,800 over one month.
    const entries = installments({
      priceMinor: 1_000n,
      depositMinor: 100n,
      markupBps: MAX_MARKUP_BPS,
      months: 1
    })
    expect(entries.map((e) => e.amountDueMinor)).toEqual([100n, 1_800n])
    expect(totalScheduledMinor(entries)).toBe(1_900n)
  })

  it('does not mark up the deposit entry', () => {
    const entries = installments({
      priceMinor: 5_000_000n,
      depositMinor: 1_400_000n,
      markupBps: 2_500
    })
    expect(entries[0].sequence).toBe(DEPOSIT_SEQUENCE)
    expect(entries[0].amountDueMinor).toBe(1_400_000n)
  })

  it('does not shift any due date', () => {
    const plain = installments({ months: 12, depositMinor: 1_000n })
    const marked = installments({ months: 12, depositMinor: 1_000n, markupBps: 1_000 })
    expect(marked.map((e) => iso(e.dueDate))).toEqual(plain.map((e) => iso(e.dueDate)))
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
  const base = {
    planType: 'INSTALLMENTS',
    priceMinor: 1000n,
    depositMinor: 0n,
    markupBps: 0,
    months: 12,
    signedAt: utc(2026, 8, 9)
  } satisfies Parameters<typeof generateSchedule>[0]

  const cases: Array<[string, Parameters<typeof generateSchedule>[0]]> = [
    ['deposit equal to price', { ...base, depositMinor: 1000n }],
    ['deposit greater than price', { ...base, depositMinor: 1001n }],
    ['negative deposit', { ...base, depositMinor: -1n }],
    ['zero price', { ...base, priceMinor: 0n }],
    ['negative price', { ...base, priceMinor: -5n }],
    ['zero months', { ...base, months: 0 }],
    ['negative months', { ...base, months: -3 }],
    ['fractional months', { ...base, months: 12.5 }],
    ['invalid signing date', { ...base, signedAt: new Date('nonsense') }],
    ['negative markup', { ...base, markupBps: -1 }],
    ['a markup above 100%', { ...base, markupBps: MAX_MARKUP_BPS + 1 }],
    ['an absurd markup', { ...base, markupBps: 1_000_000 }],
    // A fractional rate is the likeliest real mistake: someone passing a
    // percentage (10.5) where basis points belong. BigInt() would throw a bare
    // RangeError on it, so it is checked explicitly and reported as a domain error.
    ['a fractional markup', { ...base, markupBps: 1_000.5 }],
    ['a markup expressed as a percentage float', { ...base, markupBps: 10.5 }],
    ['a NaN markup', { ...base, markupBps: Number.NaN }],
    ['an infinite markup', { ...base, markupBps: Number.POSITIVE_INFINITY }],
    ['a markup on a full-payment sale', { ...base, planType: 'FULL', markupBps: 1_000 }]
  ]

  for (const [label, input] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => generateSchedule(input)).toThrow(ScheduleError)
    })
  }
})
