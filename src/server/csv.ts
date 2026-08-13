/**
 * RFC 4180 CSV, written by hand because the whole of it is thirty lines and a
 * dependency for this would be a dependency to audit.
 *
 * The one thing this file exists to get right is quoting. A buyer named
 * `Smith, John` in an unquoted field shifts every column to its right by one,
 * and the person reading the spreadsheet does not get an error — they get a
 * phone number in the project column and a plausible-looking report that is
 * wrong. Same for a name carrying a `"` (which must be doubled) or an address
 * with a newline in it.
 */

/**
 * Excel on Windows reads a BOM-less UTF-8 file as the system codepage, so
 * `Zainab Bello` survives and `Adékúnlé` does not. Three bytes fixes it, and
 * every other reader treats a leading BOM as whitespace.
 */
export const CSV_BOM = '﻿'

/** CRLF, as RFC 4180 specifies. Excel is happier and everything else is fine. */
const CSV_NEWLINE = '\r\n'

const NEEDS_QUOTING = /[",\r\n]/

/**
 * One field, quoted only when it has to be.
 *
 * Quoting selectively rather than always is not cosmetic: a numeric column that
 * arrives as `"936111.11"` is text in some spreadsheet importers, and a CSV whose
 * amounts cannot be summed is decoration. So the amount columns come through
 * here as bare digits, and only the free-text ones get quotes.
 */
export function csvField(value: string): string {
  return NEEDS_QUOTING.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** A table of already-stringified cells as one CSV body. No BOM — see `CSV_BOM`. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvField).join(',')).join(CSV_NEWLINE) + CSV_NEWLINE
}
