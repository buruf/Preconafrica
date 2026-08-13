import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERM_MONTHS,
  DEPOSIT_SEQUENCE,
  MAX_MARKUP_BPS,
  NO_INSTALLMENT_FEE,
  ScheduleError,
  bpsToPercentString,
  computeInstallmentFeeMinor,
  generateSchedule,
  installmentFeeLabel,
  installmentFeeRateSuffix,
  installmentFeeSummary,
  isFreeInstallmentFee,
  percentToBps,
  scheduleEntryLabel,
  totalScheduledMinor,
  type InstallmentFeeConfig
} from '@/domain/schedule'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
const iso = (d: Date) => d.toISOString().slice(0, 10)

/** The two fee configs, spelled once so every case below reads as its charge. */
const percent = (bps: number): InstallmentFeeConfig => ({ mode: 'PERCENT', bps, fixedMinor: 0n })
const fixed = (fixedMinor: bigint): InstallmentFeeConfig => ({
  mode: 'FIXED',
  bps: 0,
  fixedMinor
})
const FREE = percent(0)

const installments = (over: Partial<Parameters<typeof generateSchedule>[0]> = {}) =>
  generateSchedule({
    planType: 'INSTALLMENTS',
    priceMinor: 3_600_000n,
    depositMinor: 0n,
    fee: FREE,
    months: 36,
    signedAt: utc(2026, 8, 9),
    ...over
  })

const full = (over: Partial<Parameters<typeof generateSchedule>[0]> = {}) =>
  generateSchedule({
    planType: 'FULL',
    priceMinor: 1_000n,
    depositMinor: 0n,
    fee: FREE,
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

  it('rejects an installment charge on a full-payment sale, in either mode', () => {
    // Nothing is financed, so there is nothing to charge for. A project default
    // that leaked onto a FULL plan must fail loudly rather than be ignored —
    // ignoring it means the schedule and whatever the UI quoted disagree. Both
    // modes are checked because a FIXED project has the same leak available.
    expect(() => full({ fee: percent(1_000) })).toThrow(ScheduleError)
    expect(() => full({ fee: percent(1) })).toThrow(ScheduleError)
    expect(() => full({ fee: fixed(1n) })).toThrow(ScheduleError)
    expect(() => full({ fee: fixed(500_000n) })).toThrow(ScheduleError)
    expect(() => full({ fee: percent(1_000) })).toThrow(/installment charge/i)
    expect(() => full({ fee: fixed(1n) })).toThrow(/installment charge/i)
  })

  it('accepts a zero charge in either mode, since neither charges anything', () => {
    expect(full({ fee: percent(0) })).toHaveLength(1)
    expect(full({ fee: fixed(0n) })).toHaveLength(1)
    expect(full({ fee: NO_INSTALLMENT_FEE })).toHaveLength(1)
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
  // Every price x deposit x term case is now run against every fee, in both
  // modes, because the invariant is what makes the second mode safe: whatever
  // the charge is and however it is expressed, the schedule must sum to exactly
  // the price plus that charge.
  const prices = [100_000n, 3_600_001n, 25_000_000_000n, 999_999_999n, 7n, 1_250n]
  const deposits = [0n, 1n, 1_000n, 500_000n]
  const terms = [1, 2, 6, 12, 24, 36, 60, 120]

  // 0 proves the charge is genuinely optional; 500 and 1000 are the rates a
  // developer would actually charge; 3333 is deliberately awful — it divides
  // evenly into nothing, so every rounding step has a remainder to lose.
  const percentFees = [0, 500, 1_000, 3_333].map(percent)
  // 0 for the same reason; 1 is the smallest charge that exists; 6 and 1,249
  // are chosen to sit just under the tightest financed amounts in the grid
  // (price 7 deposit 1, price 1,250 deposit 0), so the "strictly less than
  // financed" boundary is exercised rather than politely avoided.
  const fixedFees = [0n, 1n, 6n, 1_249n, 250_000n].map(fixed)
  const fees = [...percentFees, ...fixedFees]

  const feeLabel = (fee: InstallmentFeeConfig) =>
    fee.mode === 'PERCENT' ? `${fee.bps}bps` : `fixed ${fee.fixedMinor}`

  it(`always sums to exactly the price plus the charge, across both modes`, () => {
    let checked = 0

    for (const priceMinor of prices) {
      for (const depositMinor of deposits) {
        if (depositMinor >= priceMinor) continue
        const financedMinor = priceMinor - depositMinor

        for (const fee of fees) {
          // A flat fee at or above the financed amount is refused by design —
          // it is a misplaced decimal point, not a plan. Asserted here rather
          // than skipped, so the boundary is covered by the same grid.
          if (fee.mode === 'FIXED' && fee.fixedMinor >= financedMinor) {
            expect(() =>
              generateSchedule({
                planType: 'INSTALLMENTS',
                priceMinor,
                depositMinor,
                fee,
                months: 12,
                signedAt: utc(2026, 1, 31)
              })
            ).toThrow(ScheduleError)
            continue
          }

          for (const months of terms) {
            const label = `price=${priceMinor} deposit=${depositMinor} fee=${feeLabel(fee)} months=${months}`
            const entries = generateSchedule({
              planType: 'INSTALLMENTS',
              priceMinor,
              depositMinor,
              fee,
              months,
              signedAt: utc(2026, 1, 31)
            })

            // The whole contract is in the schedule: nothing about this sale is
            // owed that is not one of these entries, and nothing is double
            // counted. This is the one assertion every other money figure in
            // the platform — balance, arrears, statement total — rests on.
            const feeMinor = computeInstallmentFeeMinor(financedMinor, fee)
            expect(totalScheduledMinor(entries), label).toBe(priceMinor + feeMinor)
            expect(entries, label).toHaveLength(depositMinor > 0n ? months + 1 : months)

            // The deposit is never charged — only the financed part is — so the
            // months carry exactly the financed amount plus the charge.
            const monthly = entries.filter((e) => e.sequence !== DEPOSIT_SEQUENCE)
            expect(totalScheduledMinor(monthly), label).toBe(financedMinor + feeMinor)
            expect(monthly, label).toHaveLength(months)

            // No entry is ever negative: a floor-divided base plus a remainder
            // absorbed by the last installment can never produce one, and a
            // negative amount due would break allocation and every total.
            for (const entry of entries) {
              expect(entry.amountDueMinor >= 0n, `${label} seq=${entry.sequence}`).toBe(true)
            }

            checked += 1
          }
        }
      }
    }

    // The grid is meant to be large; a refactor that quietly narrowed it to a
    // handful of cases would otherwise still pass.
    expect(checked).toBeGreaterThan(500)
  })

  it('a fixed fee is the same money whatever is financed, and a percentage is not', () => {
    // The defining difference between the modes, stated as an assertion rather
    // than left implicit in the grid above. Same fee config, two very different
    // financed amounts: FIXED charges the identical sum, PERCENT does not.
    const flat = fixed(250_000n)
    const rate = percent(1_000)
    const chargeOn = (priceMinor: bigint, fee: InstallmentFeeConfig) =>
      totalScheduledMinor(installments({ priceMinor, fee, months: 12 })) - priceMinor

    expect(chargeOn(2_000_000n, flat)).toBe(250_000n)
    expect(chargeOn(200_000_000n, flat)).toBe(250_000n)

    expect(chargeOn(2_000_000n, rate)).toBe(200_000n)
    expect(chargeOn(200_000_000n, rate)).toBe(20_000_000n)
  })

  it('a fixed fee ignores the deposit, where a percentage does not', () => {
    // A larger deposit finances less, so a PERCENT charge falls; a flat fee is
    // the price of the service, not of the money, so it does not move.
    const charge = (depositMinor: bigint, fee: InstallmentFeeConfig) =>
      totalScheduledMinor(
        installments({ priceMinor: 10_000_000n, depositMinor, fee, months: 36 })
      ) - 10_000_000n

    expect(charge(0n, fixed(250_000n))).toBe(250_000n)
    expect(charge(9_000_000n, fixed(250_000n))).toBe(250_000n)

    expect(charge(0n, percent(1_000))).toBe(1_000_000n)
    expect(charge(9_000_000n, percent(1_000))).toBe(100_000n)
  })

  it('reduces to the price when nothing is charged, in either mode', () => {
    // The pre-fee contract, still intact: a 0 bps plan, a zero flat fee and a
    // full-payment sale all total exactly the price.
    expect(
      totalScheduledMinor(installments({ priceMinor: 5_000_000n, depositMinor: 1_400_000n }))
    ).toBe(5_000_000n)
    expect(
      totalScheduledMinor(
        installments({ priceMinor: 5_000_000n, depositMinor: 1_400_000n, fee: fixed(0n) })
      )
    ).toBe(5_000_000n)
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

describe('computeInstallmentFeeMinor — PERCENT', () => {
  it('reads basis points as hundredths of a percent', () => {
    expect(computeInstallmentFeeMinor(10_000_000n, percent(1_000))).toBe(1_000_000n) // 10%
    expect(computeInstallmentFeeMinor(10_000_000n, percent(500))).toBe(500_000n) // 5%
    expect(computeInstallmentFeeMinor(10_000_000n, percent(1))).toBe(1_000n) // 0.01%
    expect(computeInstallmentFeeMinor(10_000_000n, percent(MAX_MARKUP_BPS))).toBe(10_000_000n)
  })

  it('charges nothing at zero basis points', () => {
    expect(computeInstallmentFeeMinor(999_999_999n, percent(0))).toBe(0n)
    expect(computeInstallmentFeeMinor(0n, percent(0))).toBe(0n)
  })

  it('floors the fraction of a minor unit in the buyer’s favour', () => {
    // 9,000,001 at 33.33% is 2,999,700.3333 — the buyer is charged 2,999,700.
    expect(computeInstallmentFeeMinor(9_000_001n, percent(3_333))).toBe(2_999_700n)
    // Under a full minor unit of charge rounds away entirely rather than up.
    expect(computeInstallmentFeeMinor(1n, percent(500))).toBe(0n)
    expect(computeInstallmentFeeMinor(199n, percent(500))).toBe(9n)
  })

  it('stays exact at a scale that would break a float', () => {
    // 0.1 has no exact binary representation, so `financed * 0.1` on a number
    // this large loses minor units. In BigInt with basis points it cannot.
    expect(computeInstallmentFeeMinor(25_000_000_000_000n, percent(1_000))).toBe(
      2_500_000_000_000n
    )
  })

  it('rejects a rate outside 0–100%', () => {
    expect(() => computeInstallmentFeeMinor(1_000n, percent(-1))).toThrow(ScheduleError)
    expect(() => computeInstallmentFeeMinor(1_000n, percent(MAX_MARKUP_BPS + 1))).toThrow(
      ScheduleError
    )
    expect(() => computeInstallmentFeeMinor(1_000n, percent(12.5))).toThrow(ScheduleError)
  })
})

describe('computeInstallmentFeeMinor — FIXED', () => {
  it('returns the flat amount whatever is financed', () => {
    // The defining property of the mode: the charge does not vary with the sum
    // financed, because a charge that did would be interest.
    for (const financed of [250_001n, 1_000_000n, 25_000_000_000_000n]) {
      expect(computeInstallmentFeeMinor(financed, fixed(250_000n))).toBe(250_000n)
    }
  })

  it('charges nothing at zero', () => {
    expect(computeInstallmentFeeMinor(999_999_999n, fixed(0n))).toBe(0n)
  })

  it('does not consult the basis points a FIXED config happens to carry', () => {
    // The inactive field is expected to be zero, but a config that carried a
    // stale rate must still charge the flat fee and nothing else — otherwise
    // switching a project's mode could silently reintroduce a percentage.
    const stale: InstallmentFeeConfig = { mode: 'FIXED', bps: 5_000, fixedMinor: 250_000n }
    expect(computeInstallmentFeeMinor(10_000_000n, stale)).toBe(250_000n)
  })

  it('accepts a fee one minor unit below the financed amount', () => {
    expect(computeInstallmentFeeMinor(1_000n, fixed(999n))).toBe(999n)
  })

  it('rejects a fee equal to or above the financed amount', () => {
    // A misplaced decimal point, not a business model: equal doubles what the
    // buyer owes for the privilege of paying monthly, and above makes the fee
    // the purchase.
    expect(() => computeInstallmentFeeMinor(1_000n, fixed(1_000n))).toThrow(ScheduleError)
    expect(() => computeInstallmentFeeMinor(1_000n, fixed(1_001n))).toThrow(ScheduleError)
    expect(() => computeInstallmentFeeMinor(1_000n, fixed(250_000_000n))).toThrow(
      /less than the amount being financed/i
    )
  })

  it('rejects a negative fee', () => {
    expect(() => computeInstallmentFeeMinor(1_000n, fixed(-1n))).toThrow(ScheduleError)
    expect(() => computeInstallmentFeeMinor(1_000n, fixed(-1n))).toThrow(/negative/i)
  })

  it('rejects a negative financed amount in either mode', () => {
    expect(() => computeInstallmentFeeMinor(-1n, percent(1_000))).toThrow(ScheduleError)
    expect(() => computeInstallmentFeeMinor(-1n, fixed(0n))).toThrow(ScheduleError)
  })

  it('rejects a mode it does not know', () => {
    const bogus = { mode: 'ANNUAL', bps: 0, fixedMinor: 0n } as unknown as InstallmentFeeConfig
    expect(() => computeInstallmentFeeMinor(1_000n, bogus)).toThrow(ScheduleError)
  })
})

describe('isFreeInstallmentFee', () => {
  it('is true only when the live value of the mode is zero', () => {
    expect(isFreeInstallmentFee(percent(0))).toBe(true)
    expect(isFreeInstallmentFee(fixed(0n))).toBe(true)
    expect(isFreeInstallmentFee(NO_INSTALLMENT_FEE)).toBe(true)

    expect(isFreeInstallmentFee(percent(1))).toBe(false)
    expect(isFreeInstallmentFee(fixed(1n))).toBe(false)
  })

  it('ignores the inactive field entirely', () => {
    // A FIXED config carrying a stale rate is still free if its amount is zero,
    // and a PERCENT config carrying a stale amount is still free at 0 bps.
    expect(isFreeInstallmentFee({ mode: 'FIXED', bps: 5_000, fixedMinor: 0n })).toBe(true)
    expect(isFreeInstallmentFee({ mode: 'PERCENT', bps: 0, fixedMinor: 250_000n })).toBe(true)
  })
})

describe('how a charge is labelled', () => {
  // The rule the whole FIXED mode would be undone by breaking: a flat fee must
  // never be shown with a percentage beside it. Four display sites depend on
  // these two functions, so they are asserted here rather than in each.
  it('quotes the rate for a percentage', () => {
    expect(installmentFeeRateSuffix(percent(1_000))).toBe(' (10%)')
    expect(installmentFeeLabel(percent(1_000))).toBe('Installment charge (10%)')
    expect(installmentFeeLabel(percent(1_025))).toBe('Installment charge (10.25%)')
  })

  it('never prints a percentage for a fixed fee', () => {
    expect(installmentFeeRateSuffix(fixed(250_000n))).toBe('')
    expect(installmentFeeLabel(fixed(250_000n))).toBe('Installment charge')
    expect(installmentFeeLabel(fixed(250_000n))).not.toContain('%')
    // Even one carrying a stale rate in its unused field.
    expect(installmentFeeLabel({ mode: 'FIXED', bps: 1_000, fixedMinor: 250_000n })).toBe(
      'Installment charge'
    )
  })

  it('summarises a project default as a rate or as money, never as both', () => {
    expect(installmentFeeSummary(percent(1_000), 'NGN')).toBe('10%')
    expect(installmentFeeSummary(percent(0), 'NGN')).toBe('0%')

    const flat = installmentFeeSummary(fixed(250_000_000n), 'NGN')
    expect(flat).toContain('2,500,000.00')
    expect(flat).not.toContain('%')

    // Currency-aware, like every other money string: UGX has no minor unit.
    expect(installmentFeeSummary(fixed(2_500_000n), 'UGX')).toContain('2,500,000')
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
      fee: percent(1_000),
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
      fee: percent(3_333),
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
        installments({ priceMinor: 10_000_000n, depositMinor, fee: percent(1_000), months: 36 })
      ) - 10_000_000n

    expect(charge(0n)).toBe(1_000_000n)
    expect(charge(1_000_000n)).toBe(900_000n)
    expect(charge(9_000_000n)).toBe(100_000n)
  })

  it('leaves the schedule untouched at zero basis points', () => {
    const marked = installments({ priceMinor: 5_000_000n, depositMinor: 1_400_000n, fee: percent(0) })
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
      fee: percent(MAX_MARKUP_BPS),
      months: 1
    })
    expect(entries.map((e) => e.amountDueMinor)).toEqual([100n, 1_800n])
    expect(totalScheduledMinor(entries)).toBe(1_900n)
  })

  it('does not mark up the deposit entry', () => {
    const entries = installments({
      priceMinor: 5_000_000n,
      depositMinor: 1_400_000n,
      fee: percent(2_500)
    })
    expect(entries[0].sequence).toBe(DEPOSIT_SEQUENCE)
    expect(entries[0].amountDueMinor).toBe(1_400_000n)
  })

  it('does not shift any due date', () => {
    const plain = installments({ months: 12, depositMinor: 1_000n })
    const marked = installments({ months: 12, depositMinor: 1_000n, fee: percent(1_000) })
    expect(marked.map((e) => iso(e.dueDate))).toEqual(plain.map((e) => iso(e.dueDate)))
  })
})

describe('generateSchedule — a fixed installment charge', () => {
  it('amortizes the financed amount plus the flat fee, hand-checked', () => {
    // The seeded Sunrise Heights case, in minor units. Price 85,000,000.00,
    // deposit 25,000,000.00, flat fee 2,500,000.00 over 36 months:
    //   financed 6,000,000,000 → +250,000,000 → charged 6,250,000,000
    //   6,250,000,000 / 36 = 173,611,111.11 → 173,611,111 a month,
    //   final 6,250,000,000 − 35 × 173,611,111 = 173,611,115.
    const entries = installments({
      priceMinor: 8_500_000_000n,
      depositMinor: 2_500_000_000n,
      fee: fixed(250_000_000n),
      months: 36
    })

    expect(entries).toHaveLength(37)
    expect(entries[0].amountDueMinor).toBe(2_500_000_000n) // the deposit, uncharged
    for (const entry of entries.slice(1, 36)) {
      expect(entry.amountDueMinor).toBe(173_611_111n)
    }
    expect(entries[36].amountDueMinor).toBe(173_611_115n)
    expect(totalScheduledMinor(entries)).toBe(8_750_000_000n)
    expect(totalScheduledMinor(entries)).toBe(8_500_000_000n + 250_000_000n)
  })

  it('puts the remainder on the final installment, exactly as PERCENT does', () => {
    // Financed 900, fee 101, charged 1,001 over 36: 27 a month, last 1,001 −
    // 35×27 = 56. The fee changes the numerator and nothing about the rounding.
    const entries = installments({
      priceMinor: 1_000n,
      depositMinor: 100n,
      fee: fixed(101n),
      months: 36
    })
    for (const entry of entries.slice(1, 36)) {
      expect(entry.amountDueMinor).toBe(27n)
    }
    expect(entries[36].amountDueMinor).toBe(56n)
    expect(totalScheduledMinor(entries)).toBe(1_101n)
  })

  it('does not charge the deposit entry', () => {
    const entries = installments({
      priceMinor: 5_000_000n,
      depositMinor: 1_400_000n,
      fee: fixed(200_000n)
    })
    expect(entries[0].sequence).toBe(DEPOSIT_SEQUENCE)
    expect(entries[0].amountDueMinor).toBe(1_400_000n)
  })

  it('does not shift any due date', () => {
    const plain = installments({ months: 12, depositMinor: 1_000n })
    const charged = installments({ months: 12, depositMinor: 1_000n, fee: fixed(50_000n) })
    expect(charged.map((e) => iso(e.dueDate))).toEqual(plain.map((e) => iso(e.dueDate)))
  })

  it('refuses a flat fee that is not smaller than what is financed', () => {
    // Financed here is 3,600,000. Equal and above are both refused; one minor
    // unit below is fine.
    expect(() => installments({ fee: fixed(3_600_000n) })).toThrow(ScheduleError)
    expect(() => installments({ fee: fixed(3_600_001n) })).toThrow(ScheduleError)
    expect(() => installments({ fee: fixed(999_999_999n) })).toThrow(
      /less than the amount being financed/i
    )
    expect(totalScheduledMinor(installments({ fee: fixed(3_599_999n) }))).toBe(7_199_999n)
  })

  it('measures the fee against the financed amount, not the price', () => {
    // Price 3,600,000 with a 3,000,000 deposit finances only 600,000, so a
    // 1,000,000 fee is refused even though it is well under the price. The
    // deposit is what decides, because the deposit is what is not financed.
    expect(() =>
      installments({ depositMinor: 3_000_000n, fee: fixed(1_000_000n) })
    ).toThrow(ScheduleError)
    expect(
      totalScheduledMinor(installments({ depositMinor: 3_000_000n, fee: fixed(599_999n) }))
    ).toBe(4_199_999n)
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
    fee: FREE,
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

    // PERCENT: the rate must be a whole number of basis points in 0..10000.
    ['a negative rate', { ...base, fee: percent(-1) }],
    ['a rate above 100%', { ...base, fee: percent(MAX_MARKUP_BPS + 1) }],
    ['an absurd rate', { ...base, fee: percent(1_000_000) }],
    // A fractional rate is the likeliest real mistake: someone passing a
    // percentage (10.5) where basis points belong. BigInt() would throw a bare
    // RangeError on it, so it is checked explicitly and reported as a domain error.
    ['a fractional rate', { ...base, fee: percent(1_000.5) }],
    ['a rate expressed as a percentage float', { ...base, fee: percent(10.5) }],
    ['a NaN rate', { ...base, fee: percent(Number.NaN) }],
    ['an infinite rate', { ...base, fee: percent(Number.POSITIVE_INFINITY) }],
    ['a rate on a full-payment sale', { ...base, planType: 'FULL', fee: percent(1_000) }],

    // FIXED: the amount must be a non-negative bigint, strictly under financed.
    ['a negative flat fee', { ...base, fee: fixed(-1n) }],
    ['a flat fee equal to the financed amount', { ...base, fee: fixed(1_000n) }],
    ['a flat fee above the financed amount', { ...base, fee: fixed(1_001n) }],
    ['a flat fee on a full-payment sale', { ...base, planType: 'FULL', fee: fixed(1n) }],
    // A number where a bigint belongs — the FIXED counterpart of passing 10.5
    // basis points, and the mistake a hand-built config is most likely to make.
    [
      'a flat fee that is not a bigint',
      { ...base, fee: { mode: 'FIXED', bps: 0, fixedMinor: 500 } as unknown as InstallmentFeeConfig }
    ],
    [
      'a fee mode that does not exist',
      { ...base, fee: { mode: 'ANNUAL', bps: 0, fixedMinor: 0n } as unknown as InstallmentFeeConfig }
    ]
  ]

  for (const [label, input] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => generateSchedule(input)).toThrow(ScheduleError)
    })
  }
})

describe('scheduleEntryLabel', () => {
  it('names the deposit rather than numbering it', () => {
    expect(scheduleEntryLabel(DEPOSIT_SEQUENCE)).toBe('Deposit')
  })

  it('leaves every monthly installment as its own number', () => {
    for (const sequence of [1, 2, 12, 36, 360]) {
      expect(scheduleEntryLabel(sequence)).toBe(String(sequence))
    }
  })
})

describe('percentToBps', () => {
  const cases: Array<[string, number]> = [
    ['0', 0],
    ['10', 1_000],
    ['7.5', 750],
    ['7.50', 750],
    ['10.25', 1_025],
    ['0.01', 1],
    ['0.1', 10],
    ['100', MAX_MARKUP_BPS],
    ['100.00', MAX_MARKUP_BPS],
    // Typed the way a person types it, rather than the way a parser wants it.
    [' 10 ', 1_000],
    ['10%', 1_000],
    ['012.5', 1_250]
  ]

  for (const [input, expected] of cases) {
    it(`reads "${input}" as ${expected} bps`, () => {
      expect(percentToBps(input)).toBe(expected)
    })
  }

  const rejected = [
    // Three decimals cannot be held exactly in basis points. Rounding it
    // silently is how a contract ends up a rounding error short.
    '7.555',
    '10.001',
    '-5',
    '100.01',
    '101',
    '',
    'ten',
    '1e3',
    '.5',
    '5.',
    '1/2'
  ]

  for (const input of rejected) {
    it(`rejects "${input}"`, () => {
      expect(() => percentToBps(input)).toThrow(ScheduleError)
    })
  }

  it('never routes a percentage through a float', () => {
    // 10.15 * 100 is 1014.9999999999999 in IEEE-754. Parsing the digits gives
    // the integer the string actually names — this test is the reason the
    // function reads a string rather than taking a number.
    expect(percentToBps('10.15')).toBe(1_015)
    expect(percentToBps('3.35')).toBe(335)
    expect(percentToBps('8.29')).toBe(829)
  })
})

describe('bpsToPercentString', () => {
  it('prints the shortest exact percentage', () => {
    expect(bpsToPercentString(0)).toBe('0')
    expect(bpsToPercentString(1_000)).toBe('10')
    expect(bpsToPercentString(1_050)).toBe('10.5')
    expect(bpsToPercentString(1_025)).toBe('10.25')
    expect(bpsToPercentString(5)).toBe('0.05')
    expect(bpsToPercentString(MAX_MARKUP_BPS)).toBe('100')
  })

  it('round-trips every rate a project can hold', () => {
    // An admin who opens a form prefilled from a stored rate and saves it
    // unchanged must not re-rate the project by a hundredth of a percent.
    for (let bps = 0; bps <= MAX_MARKUP_BPS; bps += 1) {
      expect(percentToBps(bpsToPercentString(bps))).toBe(bps)
    }
  })

  it('refuses a rate outside the range a schedule accepts', () => {
    expect(() => bpsToPercentString(-1)).toThrow(ScheduleError)
    expect(() => bpsToPercentString(MAX_MARKUP_BPS + 1)).toThrow(ScheduleError)
    expect(() => bpsToPercentString(10.5)).toThrow(ScheduleError)
  })
})
