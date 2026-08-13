import { describe, expect, it } from 'vitest'
import { CSV_BOM, csvField, csvSafeText, toCsv } from '@/server/csv'
import {
  ARREARS_CSV_HEADERS,
  arrearsCsvFilename,
  arrearsCsvTable
} from '@/server/services/arrears-export'
import type { ArrearsRow } from '@/server/services/arrears'

const row = (over: Partial<ArrearsRow> = {}): ArrearsRow => ({
  saleId: 's1',
  buyerId: 'b1',
  buyerName: 'Zainab Bello',
  buyerPhone: '+2348031234567',
  buyerEmail: 'zainab@buyer.test',
  projectId: 'p1',
  projectName: 'Sunrise Heights',
  unitName: '303',
  currency: 'NGN',
  overdueCount: 1,
  overdueAmountMinor: 93_611_111n,
  oldestDueDate: new Date('2026-05-01T00:00:00Z'),
  daysLate: 103,
  ...over
})

describe('csvField', () => {
  it('leaves an ordinary field alone, so a number stays a number', () => {
    // The whole point: a spreadsheet must see 936111.11 as a value it can sum,
    // not as the text "936111.11".
    expect(csvField('936111.11')).toBe('936111.11')
    expect(csvField('Zainab Bello')).toBe('Zainab Bello')
  })

  it('quotes a field containing a comma', () => {
    // Unquoted, this name shifts every column to its right by one and the reader
    // gets a plausible report that is wrong.
    expect(csvField('Smith, John')).toBe('"Smith, John"')
  })

  it('quotes and doubles an embedded quote', () => {
    expect(csvField('Smith, John "JJ"')).toBe('"Smith, John ""JJ"""')
    expect(csvField('6" pipe')).toBe('"6"" pipe"')
  })

  it('quotes a field containing a newline or a carriage return', () => {
    expect(csvField('12 Marina\nLagos')).toBe('"12 Marina\nLagos"')
    expect(csvField('a\rb')).toBe('"a\rb"')
  })

  it('leaves an empty field empty rather than writing two quotes', () => {
    expect(csvField('')).toBe('')
  })
})

describe('csvSafeText', () => {
  it('defuses every character Excel reads as the start of a formula', () => {
    // One case per lead. `=` and `@` are the injection classics; `+` and `-` are
    // the ones that also silently corrupt ordinary data.
    expect(csvSafeText('=HYPERLINK("http://evil","click")')).toBe(
      '\'=HYPERLINK("http://evil","click")'
    )
    expect(csvSafeText("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0")
    expect(csvSafeText('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)")
    expect(csvSafeText('-2+3')).toBe("'-2+3")
    // Tab and CR are stripped by Excel's importer before it looks at the next
    // character, so a formula hidden behind one is still a formula.
    expect(csvSafeText('\t=1+1')).toBe("'\t=1+1")
    expect(csvSafeText('\r=1+1')).toBe("'\r=1+1")
  })

  it('keeps the + on a phone number instead of letting Excel evaluate it', () => {
    // The non-security half, and the one that fires on every row: unguarded,
    // Excel evaluates +254733222111 to the number 254733222111 and the + is gone.
    expect(csvSafeText('+254733222111')).toBe("'+254733222111")
    expect(csvSafeText('+2348031234567')).toBe("'+2348031234567")
  })

  it('leaves an ordinary text field completely alone', () => {
    // No apostrophe on anything that did not need one — the wart is paid for
    // only where it buys something.
    expect(csvSafeText('Zainab Bello')).toBe('Zainab Bello')
    expect(csvSafeText('Smith, John "JJ"')).toBe('Smith, John "JJ"')
    expect(csvSafeText('NGN')).toBe('NGN')
    expect(csvSafeText('')).toBe('')
    // A lead character anywhere but the front is harmless and untouched.
    expect(csvSafeText('Block A-3')).toBe('Block A-3')
    expect(csvSafeText('zainab+arrears@buyer.test')).toBe('zainab+arrears@buyer.test')
  })

  it('does not quote — that is still csvField\'s job, and it composes', () => {
    // Defuse then quote, in that order, which is what arrearsCsvTable + toCsv do.
    expect(csvField(csvSafeText('=A1,B1'))).toBe('"\'=A1,B1"')
  })
})

describe('toCsv', () => {
  it('joins cells with commas and rows with CRLF, and ends with one', () => {
    expect(toCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d\r\n')
  })

  it('escapes per field, so one bad cell cannot shift the rest of the row', () => {
    expect(toCsv([['Smith, John', '1000.00', 'NGN']])).toBe('"Smith, John",1000.00,NGN\r\n')
  })

  it('offers a BOM for Excel without putting one in the body', () => {
    // Three bytes, and without them Excel on Windows reads the file as the
    // system codepage and mangles every non-ASCII name.
    //
    // Asserted by codepoint and by byte length, never by pasting the character:
    // a raw U+FEFF is invisible, so a re-encoding pass that mojibakes the source
    // to `\u00EF\u00BB\u00BF` mojibakes an identical literal here too and this test stays green
    // while the export ships garbage. `\uFEFF` cannot be corrupted silently, and
    // three bytes is the thing Excel actually reads.
    expect(CSV_BOM).toBe('\uFEFF')
    expect(CSV_BOM).toHaveLength(1)
    expect(CSV_BOM.codePointAt(0)).toBe(0xfeff)
    expect(Buffer.byteLength(CSV_BOM, 'utf8')).toBe(3)
    expect(toCsv([['a']]).startsWith(CSV_BOM)).toBe(false)
  })
})

describe('the arrears CSV table', () => {
  it('names ten columns, with the amount and its currency separate', () => {
    expect(ARREARS_CSV_HEADERS).toEqual([
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
    ])
    expect(arrearsCsvTable([row()])[0]).toHaveLength(ARREARS_CSV_HEADERS.length)
  })

  it('writes money as a bare decimal, never as a formatted string', () => {
    const [cells] = arrearsCsvTable([row()])

    expect(cells[5]).toBe('NGN')
    expect(cells[6]).toBe('936111.11')
    // The failure this pins: `formatMinor` output in the amount column, which
    // sums to zero in every spreadsheet on earth. It now also pins the other
    // direction — a formula-defusing apostrophe reaching a numeric column would
    // break the sum just as thoroughly.
    expect(cells[6]).not.toMatch(/[^\d.]/)
  })

  it('defuses the text columns and leaves every numeric column bare', () => {
    // The split that makes the export both safe and summable. The Phone column
    // begins with `+` on every row, so the defusing is not a rare path.
    const [cells] = arrearsCsvTable([
      row({
        buyerName: "=cmd|' /C calc'!A0",
        buyerPhone: '+2348031234567',
        buyerEmail: '@evil.test',
        projectName: '-Sunrise',
        unitName: '=303',
        currency: 'NGN'
      })
    ])

    expect(cells[0]).toBe("'=cmd|' /C calc'!A0")
    expect(cells[1]).toBe("'+2348031234567")
    expect(cells[2]).toBe("'@evil.test")
    expect(cells[3]).toBe("'-Sunrise")
    expect(cells[4]).toBe("'=303")
    // Untouched: it never needed defusing and must not be given an apostrophe.
    expect(cells[5]).toBe('NGN')

    // The four numeric columns, bare. A spreadsheet has to be able to sum the
    // amount, sort by days late and read the date as a date.
    expect(cells[6]).toBe('936111.11')
    expect(cells[7]).toBe('1')
    expect(cells[8]).toBe('2026-05-01')
    expect(cells[9]).toBe('103')
    for (const index of [6, 7, 8, 9]) {
      expect(cells[index].startsWith("'"), `column ${index} must not be defused`).toBe(false)
    }
  })

  it('respects the currency exponent, so a zero-decimal amount has no decimals', () => {
    // 1,300,000 RWF is 1,300,000 minor units. Dividing by 100 would report
    // 13,000 — a 100x understatement of what the buyer owes.
    const [cells] = arrearsCsvTable([
      row({ currency: 'RWF', overdueAmountMinor: 1_300_000n })
    ])
    expect(cells[5]).toBe('RWF')
    expect(cells[6]).toBe('1300000')
  })

  it('writes dates as ISO and counts as plain integers', () => {
    const [cells] = arrearsCsvTable([row({ overdueCount: 6, daysLate: 103 })])

    expect(cells[7]).toBe('6')
    expect(cells[8]).toBe('2026-05-01')
    expect(cells[9]).toBe('103')
  })

  it('keeps the service order — worst first — rather than re-sorting', () => {
    const table = arrearsCsvTable([
      row({ saleId: 'worst', buyerName: 'A', daysLate: 200 }),
      row({ saleId: 'less', buyerName: 'B', daysLate: 3 })
    ])
    expect(table.map((cells) => cells[0])).toEqual(['A', 'B'])
  })

  it('survives a buyer whose name contains a comma and a quote', () => {
    // End to end, as the route composes it: the escaped name must not move the
    // currency or the amount out of their columns.
    const body = toCsv([
      [...ARREARS_CSV_HEADERS],
      ...arrearsCsvTable([row({ buyerName: 'Smith, John "JJ"' })])
    ])
    const [, dataLine] = body.split('\r\n')

    // The name is quoted and its quote doubled, exactly as before. The phone now
    // carries a leading apostrophe — Excel reads it as text and shows
    // `+2348031234567`; without it Excel evaluates the `+` and shows
    // `2348031234567`, dropping the country-code marker on every row.
    expect(dataLine.startsWith('"Smith, John ""JJ""",\'+2348031234567,')).toBe(true)
    expect(dataLine).toContain(',NGN,936111.11,1,2026-05-01,103')
  })

  it('keeps a formula-leading name inside its own quoted field', () => {
    // Both defences at once: the apostrophe stops the formula, the quoting stops
    // the commas inside it from shifting the columns to its right.
    const body = toCsv([
      [...ARREARS_CSV_HEADERS],
      ...arrearsCsvTable([row({ buyerName: '=HYPERLINK("http://evil","click")' })])
    ])
    const [, dataLine] = body.split('\r\n')

    expect(dataLine.startsWith('"\'=HYPERLINK(""http://evil"",""click"")",')).toBe(true)
    // Unmoved, and still summable.
    expect(dataLine).toContain(',NGN,936111.11,1,2026-05-01,103')
  })
})

describe('the export filename', () => {
  it('is dated, because "overdue" is only true as at some date', () => {
    expect(arrearsCsvFilename(new Date('2026-08-12T14:05:00Z'))).toBe('arrears-2026-08-12.csv')
  })
})
