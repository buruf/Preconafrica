import { formatMinor } from '@/domain/currency'
import { addMonthsClamped, startOfUtcDay } from '@/domain/dates'

export const DEFAULT_TERM_MONTHS = 36

export type PlanType = 'FULL' | 'INSTALLMENTS'

/**
 * Whether the installment charge is a percentage of what is financed or a flat
 * sum of money. Why both exist — and why FIXED must not be "simplified" into a
 * percentage worked out per sale — is written out in full on
 * `enum InstallmentFeeMode` in prisma/schema.prisma. In short: a percentage of
 * the financed amount is interest, because it grows with the sum borrowed and
 * with nothing else, and interest is not permissible in several of the markets
 * this platform serves. A developer there must be able to charge one flat fee
 * for the service of spreading the payments.
 */
export type InstallmentFeeMode = 'PERCENT' | 'FIXED'

/**
 * A mode plus both values, rather than a union carrying one value each.
 *
 * It mirrors how the two are stored — Project and Sale each hold the mode and
 * both figures, so switching a project's mode never loses the rate it used to
 * charge — and it means the mode is the only thing a reader has to check to
 * know which number is live. The inactive field is its zero, and nothing reads
 * it.
 */
export interface InstallmentFeeConfig {
  mode: InstallmentFeeMode
  /** Basis points of the financed amount. Read only when mode is PERCENT. */
  bps: number
  /** A flat charge in minor units. Read only when mode is FIXED. */
  fixedMinor: bigint
}

/** The charge a plan that finances nothing carries: none, in either mode. */
export const NO_INSTALLMENT_FEE: InstallmentFeeConfig = Object.freeze({
  mode: 'PERCENT',
  bps: 0,
  fixedMinor: 0n
})

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
   * What the developer charges for letting the buyer pay over time. Required
   * rather than defaulted: every caller is in this repository, and a forgotten
   * charge must be a compile error, not a silently free installment plan.
   *
   * A FULL plan must pass a zero charge, in whichever mode — see below.
   */
  fee: InstallmentFeeConfig
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
 * Almost nothing downstream needs to know this constant exists: `deriveStatus`
 * turns the deposit OVERDUE the day after signing like any other entry, and the
 * reminder sweep sees one more unsettled entry. Only the three label functions
 * below care, because "0" is a correct sequence number and a terrible thing for
 * a person to read.
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
 * The same entry named as a sentence would open it — "Deposit", "Installment 3".
 *
 * `scheduleEntryLabel` is a *column* label: it lives in a table under a "#"
 * heading where the bare number is unambiguous. This one is for prose and for
 * the payment form's picker, where "3" on its own tells a person nothing about
 * what they are choosing to settle.
 */
export function scheduleEntryTitle(sequence: number): string {
  return sequence === DEPOSIT_SEQUENCE ? 'Deposit' : `Installment ${sequence}`
}

/**
 * And mid-sentence — "Recorded ₦50,000.00 against the deposit."
 *
 * A third function rather than a `.toLowerCase()` at the call site, because
 * "the deposit" takes an article and "installment 3" does not, and getting that
 * wrong is how a confirmation ends up reading "against deposit".
 */
export function scheduleEntryPhrase(sequence: number): string {
  return sequence === DEPOSIT_SEQUENCE ? 'the deposit' : `installment ${sequence}`
}

/**
 * Several entries in one phrase — "the deposit, installment 1 and installment 2".
 *
 * Voiding is the only caller, and only because history is not uniform: a
 * payment recorded under the old oldest-first cascade may hold allocations
 * across a dozen installments, and withdrawing it puts every one of them back
 * on the books. A new payment touches exactly one entry, so this returns that
 * one phrase unchanged. Sequences are listed in the order given — the caller
 * sorts, because it is the one that knows they came out of a database.
 */
export function scheduleEntryListPhrase(sequences: readonly number[]): string {
  const parts = sequences.map(scheduleEntryPhrase)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
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
 * The installment charge, in minor units, on a financed amount — in whichever
 * mode the developer charges.
 *
 * PERCENT is the original arithmetic unchanged: basis points rather than a
 * percentage float, so 10% is the integer 1000, the whole calculation stays in
 * BigInt, and no rounding error can enter through a binary fraction that cannot
 * represent 0.1. The division floors (BigInt truncates, and both operands are
 * non-negative), so the charge rounds in the buyer's favour by at most one
 * minor unit.
 *
 * FIXED returns the flat amount, whatever is being financed. There is no
 * arithmetic to do and deliberately none invented: the moment the returned
 * figure depended on `financedMinor` it would be interest again, which is the
 * one thing this mode exists to avoid.
 *
 * Exported so callers can quote the charge without re-deriving it from the
 * schedule — the preview, the two dashboards and the statement all show it as
 * its own line, and re-implementing it at each call site is how figures drift.
 */
export function computeInstallmentFeeMinor(
  financedMinor: bigint,
  fee: InstallmentFeeConfig
): bigint {
  if (financedMinor < 0n) {
    throw new ScheduleError('financedMinor cannot be negative')
  }
  assertFeeAgainstFinanced(financedMinor, fee)

  // No arithmetic in FIXED mode, by design — see above.
  if (fee.mode === 'FIXED') return fee.fixedMinor

  return (financedMinor * BigInt(fee.bps)) / BPS_DIVISOR
}

/**
 * The shape checks that need no financed amount: which mode, and is the live
 * value of that mode even representable. Run early by `generateSchedule` so a
 * malformed config is refused before anything is computed from it, and reused
 * by the service layer, which validates an override before it has a unit price.
 */
export function assertInstallmentFee(fee: InstallmentFeeConfig): void {
  if (fee.mode === 'PERCENT') {
    assertMarkupBps(fee.bps)
    return
  }
  if (fee.mode !== 'FIXED') {
    throw new ScheduleError(`Unknown installment fee mode: ${String(fee.mode)}`)
  }
  if (typeof fee.fixedMinor !== 'bigint') {
    throw new ScheduleError('A fixed installment charge must be an exact amount in minor units')
  }
  if (fee.fixedMinor < 0n) {
    throw new ScheduleError('A fixed installment charge cannot be negative')
  }
}

/**
 * The shape checks plus the one that needs the financed amount: a flat fee has
 * to be strictly smaller than the thing being financed.
 *
 * Strictly, not "at most": a fee equal to the financed amount doubles what the
 * buyer owes for the privilege of paying in installments, and one larger than
 * it means the fee is the purchase. Neither is a business model — both are a
 * misplaced decimal point — so this is the FIXED counterpart of the 0..10000
 * bound PERCENT gets, and it catches the same class of typo. PERCENT needs no
 * such check: 100% of the financed amount is its ceiling by construction.
 */
function assertFeeAgainstFinanced(financedMinor: bigint, fee: InstallmentFeeConfig): void {
  assertInstallmentFee(fee)
  if (fee.mode === 'FIXED' && fee.fixedMinor >= financedMinor) {
    throw new ScheduleError(
      'A fixed installment charge must be less than the amount being financed'
    )
  }
}

/** Whether this config actually charges anything. Zero in either mode is free. */
export function isFreeInstallmentFee(fee: InstallmentFeeConfig): boolean {
  return fee.mode === 'PERCENT' ? fee.bps === 0 : fee.fixedMinor === 0n
}

/**
 * The rate quoted beside the charge wherever it is shown: ' (10%)' for a
 * percentage, and — this is the point — the empty string for a flat fee.
 *
 * A FIXED charge has no rate. Deriving one for display ("₦2,500,000, which is
 * 4.2% of what you financed") would put the interest framing back on the page
 * for a developer who chose this mode precisely so it would not be there, and
 * it would print a different percentage on every unit for what is one fee. One
 * function rather than a ternary at each of the four display sites, so a fifth
 * site cannot quietly get it wrong.
 */
export function installmentFeeRateSuffix(fee: InstallmentFeeConfig): string {
  return fee.mode === 'PERCENT' ? ` (${bpsToPercentString(fee.bps)}%)` : ''
}

/** 'Installment charge (10%)' or plain 'Installment charge'. */
export function installmentFeeLabel(fee: InstallmentFeeConfig): string {
  return `Installment charge${installmentFeeRateSuffix(fee)}`
}

/**
 * The charge on its own, as a developer reads their project's default: '10%'
 * for a percentage, the formatted money for a flat fee. Needs the currency,
 * which is why it takes one — a fixed fee is meaningless without it.
 */
export function installmentFeeSummary(fee: InstallmentFeeConfig, currency: string): string {
  assertInstallmentFee(fee)
  return fee.mode === 'PERCENT'
    ? `${bpsToPercentString(fee.bps)}%`
    : formatMinor(fee.fixedMinor, currency)
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
  const { planType, priceMinor, depositMinor, fee, months, signedAt } = input

  if (Number.isNaN(signedAt.getTime())) {
    throw new ScheduleError('signedAt is not a valid date')
  }
  if (priceMinor <= 0n) {
    throw new ScheduleError('priceMinor must be greater than zero')
  }
  if (depositMinor < 0n) {
    throw new ScheduleError('depositMinor cannot be negative')
  }
  // Shape only, here: whether a FIXED fee fits inside the financed amount
  // cannot be known until the deposit has been subtracted, so that check lives
  // in `computeInstallmentFeeMinor` below, on the branch that has the figure.
  assertInstallmentFee(fee)

  const signedDay = startOfUtcDay(signedAt)

  // A full-payment sale still gets one schedule entry. An empty schedule would
  // leave the buyer with nothing to allocate a payment against, no invoice to
  // issue, and no way to appear in the arrears report if they never pay.
  if (planType === 'FULL') {
    if (depositMinor !== 0n) {
      throw new ScheduleError('a full-payment sale cannot carry a deposit')
    }
    // Nothing is financed, so there is nothing to charge for — in either mode.
    // A non-zero charge here is a caller mistake, most likely a project default
    // that leaked onto a plan it does not apply to, and silently ignoring it
    // would overcharge or undercharge depending on which figure the UI quoted.
    if (!isFreeInstallmentFee(fee)) {
      throw new ScheduleError('a full-payment sale cannot carry an installment charge')
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

  // A PERCENT charge is levied on what is actually financed — the price less
  // the deposit — so paying a larger deposit genuinely costs the buyer less. A
  // FIXED charge is the flat fee, unaffected by the deposit, which is the whole
  // point of it. Either way the installments amortize the financed amount plus
  // the charge, and the deposit entry itself is never charged.
  const feeMinor = computeInstallmentFeeMinor(financedMinor, fee)
  const chargedMinor = financedMinor + feeMinor

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
  // the schedule sums to exactly `priceMinor + feeMinor` — every naira the
  // buyer owes, and nothing that is not one of these entries. A buyer who
  // agreed a deposit and never paid it is in arrears the next day, and the only
  // way it counts toward paid-to-date is a Payment allocated against it.
  if (depositMinor === 0n) return monthly

  return [
    { sequence: DEPOSIT_SEQUENCE, dueDate: signedDay, amountDueMinor: depositMinor },
    ...monthly
  ]
}
