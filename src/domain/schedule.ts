import { addMonthsClamped, startOfUtcDay } from '@/domain/dates'

export const DEFAULT_TERM_MONTHS = 36

export type PlanType = 'FULL' | 'INSTALLMENTS'

export interface ScheduleEntryDraft {
  sequence: number
  dueDate: Date
  amountDueMinor: bigint
}

export interface ScheduleInput {
  planType: PlanType
  priceMinor: bigint
  depositMinor: bigint
  /**
   * What the developer charges for letting the buyer pay over time, in basis
   * points of the financed amount. Required rather than defaulted: every caller
   * is in this repository, and a forgotten markup must be a compile error, not
   * a silently free installment plan.
   *
   * Ignored for FULL plans, which must pass 0 — see below.
   */
  markupBps: number
  /** Ignored for FULL plans. */
  months: number
  signedAt: Date
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleError'
  }
}

/**
 * The deposit's sequence number. Zero rather than one so the monthly
 * installments keep the numbers the contract and every issued document already
 * use: the first month is still installment 1 of 36, not 2 of 37.
 *
 * Nothing downstream needs to know this constant exists. `allocatePayment`
 * orders by sequence ascending, so a payment settles the deposit first with no
 * special case; `deriveStatus` turns it OVERDUE the day after signing like any
 * other entry; the reminder sweep sees one more unsettled entry.
 */
export const DEPOSIT_SEQUENCE = 0

/** One hundred percent. A markup may equal the financed amount but not exceed it. */
export const MAX_MARKUP_BPS = 10_000

const BPS_DIVISOR = 10_000n

export function totalScheduledMinor(entries: ScheduleEntryDraft[]): bigint {
  return entries.reduce((sum, entry) => sum + entry.amountDueMinor, 0n)
}

/**
 * How a schedule entry is named wherever a person reads one — a table row, a
 * PDF column, an invoice heading.
 *
 * The deposit is sequence 0, which is a correct number and a terrible label:
 * "0." above the signing-day amount reads like a placeholder or a bug, and on
 * an invoice "installment 0 of 36" reads like a mistake in the contract. One
 * function rather than a ternary at each of the six call sites, so the deposit
 * cannot end up called "Deposit" on the dashboard and "0" on the statement.
 */
export function scheduleEntryLabel(sequence: number): string {
  return sequence === DEPOSIT_SEQUENCE ? 'Deposit' : String(sequence)
}

/**
 * Percent-as-typed to basis points, exactly.
 *
 * Staff think in percent ("10%", "7.5%"); the money core thinks in basis
 * points, because an integer is the only representation of a rate that cannot
 * lose a hundredth to a binary fraction. Two decimal places is exactly the
 * precision basis points can hold, so a third decimal is rejected rather than
 * silently rounded — "7.555%" quietly becoming 755 bps is the kind of thing
 * nobody notices until a contract is short by a rounding error.
 *
 * Parsed from the string the form submitted, never from a `number`: 10.15
 * multiplied by 100 is 1014.9999999999999 in IEEE-754, which is precisely the
 * bug this whole basis-point scheme exists to avoid.
 */
export function percentToBps(percent: string): number {
  const cleaned = percent.replace(/[\s,_%]/g, '')
  const match = /^(\d+)(?:\.(\d+))?$/.exec(cleaned)
  if (!match) {
    throw new ScheduleError('Enter the installment charge as a percentage, e.g. 10 or 7.5')
  }

  const [, whole, fraction = ''] = match
  if (fraction.length > 2) {
    throw new ScheduleError('An installment charge may have at most two decimal places')
  }

  // Digit arithmetic, not `Number(cleaned) * 100`: the operands here are the
  // integers the string literally contains, so the result is exact.
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0') || '0')
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_MARKUP_BPS) {
    throw new ScheduleError(
      `The installment charge must be between 0% and ${MAX_MARKUP_BPS / 100}%`
    )
  }

  return bps
}

/**
 * Basis points back to the shortest exact percentage string: 1000 -> "10",
 * 1050 -> "10.5", 1025 -> "10.25", 0 -> "0". Used to prefill the percent input
 * from a stored rate, so `percentToBps(bpsToPercentString(x)) === x` for every
 * x in range — an admin who opens a form and saves it unchanged must not
 * re-rate the project.
 */
export function bpsToPercentString(bps: number): string {
  assertMarkupBps(bps)

  const whole = Math.trunc(bps / 100)
  const fraction = bps % 100
  if (fraction === 0) return String(whole)

  return `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`
}

/**
 * The installment charge, in minor units, on a financed amount.
 *
 * Basis points rather than a percentage float: 10% is the integer 1000, so the
 * whole calculation stays in BigInt and no rounding error can enter through a
 * binary fraction that cannot represent 0.1. The division floors (BigInt
 * truncates, and both operands are non-negative), so the charge always rounds
 * in the buyer's favour by at most one minor unit.
 *
 * Exported so callers can quote the charge without re-deriving it from the
 * schedule — the preview shows it as its own line, and re-implementing
 * `financed * bps / 10000` at each call site is how two figures drift apart.
 */
export function computeMarkupMinor(financedMinor: bigint, markupBps: number): bigint {
  assertMarkupBps(markupBps)
  if (financedMinor < 0n) {
    throw new ScheduleError('financedMinor cannot be negative')
  }
  return (financedMinor * BigInt(markupBps)) / BPS_DIVISOR
}

function assertMarkupBps(markupBps: number): void {
  // Integer-checked explicitly: BigInt(1000.5) throws a RangeError, which would
  // escape as a bug rather than as the domain error every other bad input gets.
  if (!Number.isInteger(markupBps)) {
    throw new ScheduleError('markupBps must be an integer number of basis points')
  }
  if (markupBps < 0 || markupBps > MAX_MARKUP_BPS) {
    throw new ScheduleError(`markupBps must be between 0 and ${MAX_MARKUP_BPS}`)
  }
}

export function generateSchedule(input: ScheduleInput): ScheduleEntryDraft[] {
  const { planType, priceMinor, depositMinor, markupBps, months, signedAt } = input

  if (Number.isNaN(signedAt.getTime())) {
    throw new ScheduleError('signedAt is not a valid date')
  }
  if (priceMinor <= 0n) {
    throw new ScheduleError('priceMinor must be greater than zero')
  }
  if (depositMinor < 0n) {
    throw new ScheduleError('depositMinor cannot be negative')
  }
  assertMarkupBps(markupBps)

  const signedDay = startOfUtcDay(signedAt)

  // A full-payment sale still gets one schedule entry. An empty schedule would
  // leave the buyer with nothing to allocate a payment against, no invoice to
  // issue, and no way to appear in the arrears report if they never pay.
  if (planType === 'FULL') {
    if (depositMinor !== 0n) {
      throw new ScheduleError('a full-payment sale cannot carry a deposit')
    }
    // Nothing is financed, so there is nothing to charge for. A non-zero markup
    // here is a caller mistake — most likely a project default that leaked onto
    // a plan it does not apply to — and silently ignoring it would overcharge or
    // undercharge depending on which figure the UI happened to quote.
    if (markupBps !== 0) {
      throw new ScheduleError('a full-payment sale cannot carry an installment markup')
    }
    return [{ sequence: 1, dueDate: signedDay, amountDueMinor: priceMinor }]
  }

  if (depositMinor >= priceMinor) {
    throw new ScheduleError('depositMinor must be less than priceMinor')
  }
  if (!Number.isInteger(months) || months < 1) {
    throw new ScheduleError('months must be an integer of at least 1')
  }

  const financedMinor = priceMinor - depositMinor
  const termMonths = BigInt(months)

  // The markup is charged on what is actually financed — the price less the
  // deposit — so paying a larger deposit genuinely costs the buyer less, and a
  // buyer who pays everything up front pays no charge at all. The installments
  // amortize the marked-up total; the deposit entry is never marked up.
  const markupMinor = computeMarkupMinor(financedMinor, markupBps)
  const chargedMinor = financedMinor + markupMinor

  // BigInt division truncates toward zero, which is floor for positive values —
  // exactly the "round down to the smallest minor unit" rule, with no exponent
  // needed because the operands are already minor units.
  const baseMinor = chargedMinor / termMonths
  const finalMinor = chargedMinor - baseMinor * (termMonths - 1n)

  const monthly = Array.from({ length: months }, (_, index) => {
    const sequence = index + 1
    return {
      sequence,
      dueDate: addMonthsClamped(signedDay, sequence),
      amountDueMinor: sequence === months ? finalMinor : baseMinor
    }
  })

  // The deposit is receivable, not received. It leads the schedule as its own
  // entry, due on the signing day, so the whole contract is in one place and
  // the schedule sums to exactly `priceMinor + markupMinor` — every naira the
  // buyer owes, and nothing that is not one of these entries. A buyer who
  // agreed a deposit and never paid it is in arrears the next day, and the only
  // way it counts toward paid-to-date is a Payment allocated against it.
  if (depositMinor === 0n) return monthly

  return [
    { sequence: DEPOSIT_SEQUENCE, dueDate: signedDay, amountDueMinor: depositMinor },
    ...monthly
  ]
}
