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
 *
 * The second thing is formula injection — see `csvSafeText`.
 */

/**
 * Excel on Windows reads a BOM-less UTF-8 file as the system codepage, so
 * `Zainab Bello` survives and `Adékúnlé` does not. Three bytes fixes it, and
 * every other reader treats a leading BOM as whitespace.
 *
 * Written as the escape `'\uFEFF'` and not as a literal, because a literal
 * U+FEFF is invisible: a re-encoding pass through a tool that does not preserve
 * UTF-8 turns it into `ï»¿` in this file *and* in any test that pinned it by
 * pasting the same character, so the test stays green while the export ships
 * mojibake. The escape survives re-encoding, and the test asserts three bytes.
 */
export const CSV_BOM = '\uFEFF'

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

/**
 * A cell whose first character would make Excel treat it as a formula.
 *
 * `=`, `+` and `-` open a formula; `@` opens a function name; a leading tab or
 * carriage return is stripped by Excel's importer before it looks at the next
 * character, so `\t=cmd|…` is a formula too.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/

/**
 * One *text* field, defused against spreadsheet formula injection.
 *
 * Two failures, one fix.
 *
 *  1. **Execution.** A buyer named `=HYPERLINK("http://evil","click")` is inert
 *     text in the database and a live formula the moment the developer opens the
 *     export in Excel. `=cmd|' /C calc'!A0` is the same problem with a worse
 *     ending. Nothing downstream of this file can undo it — by the time the
 *     spreadsheet is open, the CSV is the input to a program.
 *  2. **Silent corruption, which is the more likely of the two.** The Phone
 *     column starts with `+`. Excel reads `+254733222111` as a formula, evaluates
 *     it to the number `254733222111`, and the `+` is gone — so an undefended
 *     export mangles every phone number it writes, on every row, for everyone.
 *
 * The fix is the conventional one: a single leading apostrophe, which Excel and
 * LibreOffice both read as "the rest of this cell is text" and do not display.
 *
 * The trade, stated plainly: the apostrophe *is* visible in tools that do not
 * implement that convention — `cat`, a Python `csv.reader`, a naive importer.
 * That is accepted. A phone column that reads `'+254733222111` in a text editor
 * is a cosmetic wart; a phone column that reads `254733222111` in the tool the
 * user actually opens it in is wrong data, and an export that executes is a
 * vulnerability. Only the text columns come through here, so no summable number
 * can pick up the apostrophe — see `arrearsCsvTable`.
 */
export function csvSafeText(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value
}

/** A table of already-stringified cells as one CSV body. No BOM — see `CSV_BOM`. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvField).join(',')).join(CSV_NEWLINE) + CSV_NEWLINE
}
