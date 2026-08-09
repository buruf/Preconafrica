const MS_PER_DAY = 86_400_000

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * Adds whole months, clamping the day-of-month to the last valid day of the
 * target month.
 *
 * Always computed from `start`, never iteratively: iterating Jan 31 forward one
 * month at a time gives Feb 28 then Mar 28, permanently degrading the buyer's
 * due date. Recomputing from the signing date each time gives Mar 31, which is
 * what a contract means by "the 31st of each month".
 */
export function addMonthsClamped(start: Date, months: number): Date {
  if (!Number.isInteger(months)) {
    throw new RangeError(`months must be an integer, received ${months}`)
  }

  const originalDay = start.getUTCDate()
  const targetMonthStart = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1)
  )

  // Day 0 of the following month is the last day of the target month.
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetMonthStart.getUTCFullYear(), targetMonthStart.getUTCMonth() + 1, 0)
  ).getUTCDate()

  return new Date(
    Date.UTC(
      targetMonthStart.getUTCFullYear(),
      targetMonthStart.getUTCMonth(),
      Math.min(originalDay, lastDayOfTargetMonth)
    )
  )
}

export function differenceInDaysUtc(later: Date, earlier: Date): number {
  return Math.round(
    (startOfUtcDay(later).getTime() - startOfUtcDay(earlier).getTime()) / MS_PER_DAY
  )
}
