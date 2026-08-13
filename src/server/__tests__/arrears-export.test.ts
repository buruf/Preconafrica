import { describe, expect, it } from 'vitest'
import { CSV_BOM, csvField, toCsv } from '@/server/csv'
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
    expect(CSV_BOM).toBe('﻿')
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
    // sums to zero in every spreadsheet on earth.
    expect(cells[6]).not.toMatch(/[^\d.]/)
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

    expect(dataLine.startsWith('"Smith, John ""JJ""",+2348031234567,')).toBe(true)
    expect(dataLine).toContain(',NGN,936111.11,1,2026-05-01,103')
  })
})

describe('the export filename', () => {
  it('is dated, because "overdue" is only true as at some date', () => {
    expect(arrearsCsvFilename(new Date('2026-08-12T14:05:00Z'))).toBe('arrears-2026-08-12.csv')
  })
})
