import { describe, expect, it } from 'vitest'
import { CreateProjectSchema } from '@/server/services/projects'

/**
 * The completion date has to be plausible, not merely parseable.
 *
 * A native date input accepts a year up to 275760, and typing "202812" in one
 * go puts all six digits into the year segment rather than reading as December
 * 2028. Without this the row stores a building due in the year 202812, and
 * every schedule, statement and arrears calculation downstream reasons about
 * it as a real date.
 */

const VALID = {
  name: 'Khaleel Heights',
  location: 'Mogadishu, Somalia',
  currency: 'KES',
  expectedCompletion: '2028-12-31',
  floors: 4,
  unitsPerFloor: 1,
  startFloor: 1,
  namingPattern: '{floor}{index:02}',
  // The rest of a valid project, so the only thing under test is the date.
  unitTypes: [{ bedrooms: 3, sizeSqm: '120.00', price: '18500000' }],
  reminderDaysBefore: 7,
  overdueNoticeDaysAfter: 3
}

function parse(expectedCompletion: string) {
  return CreateProjectSchema.safeParse({ ...VALID, expectedCompletion })
}

/**
 * Refused *because of the date*, not merely refused.
 *
 * `success === false` alone is a trap. If `VALID` ever drifts out of step with
 * the schema — a new required field, say — every refusal test would keep
 * passing while testing nothing whatsoever. An earlier draft of this file did
 * exactly that: it was missing `unitTypes` and both reminder fields, so all
 * four refusals passed for reasons that had nothing to do with the date, and
 * would have gone on passing if the bound had never been written.
 *
 * Naming the path is what keeps the assertion attached to the thing under test.
 */
function refusedForTheDate(expectedCompletion: string): boolean {
  const result = parse(expectedCompletion)
  return (
    !result.success && result.error.issues.some((issue) => issue.path[0] === 'expectedCompletion')
  )
}

describe('expectedCompletion', () => {
  it('accepts an ordinary future completion', () => {
    expect(parse('2028-12-31').success).toBe(true)
  })

  it('accepts a date already past, for a building entered late', () => {
    expect(parse('2019-06-30').success).toBe(true)
  })

  it('refuses the six-digit year a date input will happily produce', () => {
    // The one that prompted all this: typing "202812" into a native date field
    // puts all six digits in the year segment.
    expect(refusedForTheDate('202812-12-01')).toBe(true)
  })

  it('refuses a year far in the future', () => {
    expect(refusedForTheDate('9999-01-01')).toBe(true)
  })

  it('refuses a year before 1900, which is as certainly a typo', () => {
    expect(refusedForTheDate('0202-12-01')).toBe(true)
  })

  it('still refuses something that is not a date at all', () => {
    expect(refusedForTheDate('next tuesday')).toBe(true)
  })
})
