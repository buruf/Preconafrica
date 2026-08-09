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

export function totalScheduledMinor(entries: ScheduleEntryDraft[]): bigint {
  return entries.reduce((sum, entry) => sum + entry.amountDueMinor, 0n)
}

export function generateSchedule(input: ScheduleInput): ScheduleEntryDraft[] {
  const { planType, priceMinor, depositMinor, months, signedAt } = input

  if (Number.isNaN(signedAt.getTime())) {
    throw new ScheduleError('signedAt is not a valid date')
  }
  if (priceMinor <= 0n) {
    throw new ScheduleError('priceMinor must be greater than zero')
  }
  if (depositMinor < 0n) {
    throw new ScheduleError('depositMinor cannot be negative')
  }

  const signedDay = startOfUtcDay(signedAt)

  // A full-payment sale still gets one schedule entry. An empty schedule would
  // leave the buyer with nothing to allocate a payment against, no invoice to
  // issue, and no way to appear in the arrears report if they never pay.
  if (planType === 'FULL') {
    if (depositMinor !== 0n) {
      throw new ScheduleError('a full-payment sale cannot carry a deposit')
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

  // BigInt division truncates toward zero, which is floor for positive values —
  // exactly the "round down to the smallest minor unit" rule, with no exponent
  // needed because the operands are already minor units.
  const baseMinor = financedMinor / termMonths
  const finalMinor = financedMinor - baseMinor * (termMonths - 1n)

  return Array.from({ length: months }, (_, index) => {
    const sequence = index + 1
    return {
      sequence,
      dueDate: addMonthsClamped(signedDay, sequence),
      amountDueMinor: sequence === months ? finalMinor : baseMinor
    }
  })
}
