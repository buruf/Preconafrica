import { differenceInDaysUtc, startOfUtcDay } from '@/domain/dates'

export type InstallmentStatus = 'PAID' | 'PARTIAL' | 'OVERDUE' | 'PENDING'

export interface StatusInput {
  dueDate: Date
  amountDueMinor: bigint
  amountPaidMinor: bigint
}

export function outstandingMinor(entry: StatusInput): bigint {
  const remainder = entry.amountDueMinor - entry.amountPaidMinor
  return remainder > 0n ? remainder : 0n
}

/**
 * Derived, never stored. An entry becomes overdue because a day passed, not
 * because a job ran — a persisted column would be wrong the moment a cron run
 * is delayed.
 *
 * OVERDUE outranks PARTIAL: a part-paid entry past its due date is still
 * arrears, and that is the state the developer needs to act on.
 */
export function deriveStatus(entry: StatusInput, asOf: Date): InstallmentStatus {
  if (outstandingMinor(entry) === 0n) return 'PAID'
  if (startOfUtcDay(asOf).getTime() > startOfUtcDay(entry.dueDate).getTime()) return 'OVERDUE'
  return entry.amountPaidMinor > 0n ? 'PARTIAL' : 'PENDING'
}

export function daysLate(entry: StatusInput, asOf: Date): number {
  if (deriveStatus(entry, asOf) !== 'OVERDUE') return 0
  return differenceInDaysUtc(asOf, entry.dueDate)
}
