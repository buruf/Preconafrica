import { describe, expect, it } from 'vitest'
import {
  UNKNOWN_RECORDER,
  buildInvoicePaymentRows,
  type AllocationWithPayment
} from '@/server/pdf/invoice-payments'

const AGENT = 'user_agent'

function allocation(
  amountMinor: bigint,
  receivedAt: string,
  overrides: Partial<AllocationWithPayment['payment']> = {}
): AllocationWithPayment {
  return {
    amountMinor,
    payment: {
      receivedAt: new Date(`${receivedAt}T00:00:00Z`),
      method: 'CASH',
      reference: 'RCPT-0091',
      recordedByUserId: AGENT,
      ...overrides
    }
  }
}

const names = new Map([[AGENT, 'Tunde Bakare']])

describe('buildInvoicePaymentRows', () => {
  it('prints the allocated amount, not the payment total', () => {
    // The real Joseph case: a 150,000 cash payment whose last 33,333.33 is all
    // that reached this installment. Printing the payment's own amount here
    // would show the buyer paying 150,000 toward an entry that received a
    // fifth of it — and would do so on two invoices at once.
    const rows = buildInvoicePaymentRows([allocation(3333333n, '2026-03-12')], names)

    expect(rows).toEqual([
      {
        amountMinor: 3333333n,
        receivedAt: new Date('2026-03-12T00:00:00Z'),
        method: 'CASH',
        reference: 'RCPT-0091',
        recordedBy: 'Tunde Bakare'
      }
    ])
  })

  it('orders oldest first regardless of the order it was handed', () => {
    const rows = buildInvoicePaymentRows(
      [
        allocation(100n, '2026-05-01', { reference: 'C' }),
        allocation(200n, '2026-03-01', { reference: 'A' }),
        allocation(300n, '2026-04-01', { reference: 'B' })
      ],
      names
    )

    expect(rows.map((row) => row.reference)).toEqual(['A', 'B', 'C'])
  })

  it('keeps every payment when several settle one installment', () => {
    const rows = buildInvoicePaymentRows(
      [
        allocation(15000000n, '2026-02-10', { reference: 'RCPT-0091' }),
        allocation(3333333n, '2026-03-12', { reference: 'RCPT-0114' })
      ],
      names
    )

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.amountMinor)).toEqual([15000000n, 3333333n])
  })

  it('falls back to an em dash when the recorder account is gone', () => {
    const rows = buildInvoicePaymentRows(
      [allocation(100n, '2026-03-01', { recordedByUserId: 'user_deleted' })],
      names
    )

    expect(rows[0].recordedBy).toBe(UNKNOWN_RECORDER)
  })

  it('treats a blank stored name as no name at all', () => {
    const rows = buildInvoicePaymentRows(
      [allocation(100n, '2026-03-01')],
      new Map([[AGENT, '   ']])
    )

    expect(rows[0].recordedBy).toBe(UNKNOWN_RECORDER)
  })

  it('keeps a null reference null rather than inventing one', () => {
    const rows = buildInvoicePaymentRows(
      [allocation(100n, '2026-03-01', { reference: null })],
      names
    )

    expect(rows[0].reference).toBeNull()
  })

  it('does not mutate the input order', () => {
    const input = [allocation(100n, '2026-05-01'), allocation(200n, '2026-03-01')]

    buildInvoicePaymentRows(input, names)

    expect(input[0].amountMinor).toBe(100n)
  })

  it('returns nothing for an installment with no allocations', () => {
    expect(buildInvoicePaymentRows([], names)).toEqual([])
  })
})
