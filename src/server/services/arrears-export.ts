import { toMajorString } from '@/domain/currency'
import { csvSafeText } from '@/server/csv'
import type { ArrearsRow } from '@/server/services/arrears'

/**
 * The arrears report as a table of strings, ready for `toCsv`.
 *
 * Its own module rather than inline in the route handler so it can be tested
 * without a request, a session or a database — the failure modes here are all
 * about the *shape* of a cell, and none of them need Prisma to reproduce.
 *
 * Two rules decide every column below.
 *
 *  1. **Money is a bare decimal number in its own column, with the currency
 *     beside it.** Not `NGN 936,111.11`. A collections clerk opens this file to
 *     sum a column and sort by it; a formatted string sums to zero and sorts
 *     alphabetically, and this organisation sells in NGN and KES, so a single
 *     total column would be meaningless anyway. `toMajorString` is what makes
 *     the number exact — it is exponent-aware (KES has two decimals, RWF none)
 *     and it never touches a float, unlike dividing a bigint by 100.
 *  2. **Dates are ISO.** `2026-03-10` sorts as text, parses everywhere, and does
 *     not become the tenth of March or the third of October depending on the
 *     reader's locale.
 *
 * A third rule follows from the first two rather than competing with them:
 * **every free-text cell goes through `csvSafeText` and no numeric cell does.**
 * The text cells carry whatever a buyer typed, which may open with `=` — and the
 * Phone column opens with `+` on every row, which Excel evaluates. The numeric
 * cells are generated here from bigints and dates, cannot begin with a formula
 * lead that means anything, and must stay bare so the column still sums. Keeping
 * the split at this line is what guarantees that: `csvSafeText` is applied
 * per-column, by name, not to the row.
 */
export const ARREARS_CSV_HEADERS = [
  'Buyer',
  'Phone',
  'Email',
  'Project',
  'Unit',
  'Currency',
  'Overdue amount',
  'Installments overdue',
  'Oldest due date',
  'Days late'
] as const

const isoDate = (value: Date) => value.toISOString().slice(0, 10)

/**
 * Body rows, in the order the service returned them — worst first. Sorting is
 * the report's job and the export must not quietly disagree with the screen it
 * was downloaded from.
 */
export function arrearsCsvTable(rows: readonly ArrearsRow[]): string[][] {
  return rows.map((row) => [
    // Text, so defused. See rule 3 above.
    csvSafeText(row.buyerName),
    csvSafeText(row.buyerPhone),
    csvSafeText(row.buyerEmail),
    csvSafeText(row.projectName),
    csvSafeText(row.unitName),
    csvSafeText(row.currency),
    // Numbers and a date, so bare — no `csvSafeText` below this line, ever.
    // The number on its own. See rule 1 above.
    toMajorString(row.overdueAmountMinor, row.currency),
    String(row.overdueCount),
    isoDate(row.oldestDueDate),
    String(row.daysLate)
  ])
}

/**
 * `arrears-2026-08-12.csv`. Dated, because the report is a snapshot of a moment
 * — an undated `arrears.csv` in a downloads folder beside three others is
 * useless, and "overdue" is only true as at some date.
 */
export function arrearsCsvFilename(asOf: Date): string {
  return `arrears-${isoDate(asOf)}.csv`
}
