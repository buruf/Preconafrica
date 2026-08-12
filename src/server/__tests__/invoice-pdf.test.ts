import { createElement } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { describe, expect, it } from 'vitest'
import { InvoiceDocument, type InvoiceProps } from '@/server/pdf/InvoiceDocument'
import { UNKNOWN_RECORDER } from '@/server/pdf/invoice-payments'
import { extractPdfText } from '@/server/__tests__/pdf-fixtures'

/**
 * A real render, not a snapshot of props: the failure this guards against is a
 * PDF that builds and comes out missing the thing it was issued to say. Nothing
 * short of rendering and reading the bytes back catches that.
 *
 * `createElement` rather than JSX because vitest only collects `.ts` files
 * (see `include` in vitest.config.ts); the `.tsx` component it imports is
 * compiled with the automatic JSX runtime configured there. The PDF reader and
 * the props fixture both live in `pdf-fixtures`, shared with the letterhead
 * test rather than copied into it.
 */

const BASE: InvoiceProps = {
  number: 'INV-000042',
  issuedAt: new Date('2026-08-12T09:30:00Z'),
  orgName: 'Sunrise Developments',
  // No logo set, so the masthead prints the initials placeholder ('SD', asserted
  // below). Bytes, never a URL — nothing inside a render may touch the network.
  logo: null,
  projectName: 'Riverside Court',
  projectLocation: 'Riverside Drive, Nairobi',
  unitName: '4C',
  buyerName: 'Joseph Otieno',
  buyerPhone: '+254733222111',
  buyerEmail: 'joseph@buyer.test',
  buyerAddress: 'Ngong Road, Nairobi',
  currency: 'KES',
  sequence: 2,
  termMonths: 36,
  dueDate: new Date('2026-03-10T00:00:00Z'),
  amountDueMinor: 18333333n,
  amountPaidMinor: 11666667n,
  status: 'OVERDUE',
  payments: [
    {
      amountMinor: 3333333n,
      receivedAt: new Date('2026-03-12T00:00:00Z'),
      method: 'CASH',
      reference: 'RCPT-0114',
      recordedBy: 'Tunde Bakare'
    },
    {
      amountMinor: 8333334n,
      receivedAt: new Date('2026-04-02T00:00:00Z'),
      method: 'MOBILE_MONEY',
      reference: 'MPESA-QG7H2',
      recordedBy: UNKNOWN_RECORDER
    }
  ]
}

async function render(props: Partial<InvoiceProps> = {}) {
  const element = createElement(InvoiceDocument, { ...BASE, ...props })
  // `renderToBuffer` is typed for an element whose props are DocumentProps; the
  // component's own props are the Document's children's, which is exactly what
  // JSX call sites pass too — the cast is the type-only difference between
  // writing `<InvoiceDocument …/>` in a .tsx and calling createElement here.
  const buffer = await renderToBuffer(element as Parameters<typeof renderToBuffer>[0])
  return { buffer, text: extractPdfText(buffer) }
}

describe('invoice PDF', () => {
  it('renders a real PDF carrying its number, installment label and payments', async () => {
    const { buffer, text } = await render()

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')

    expect(text).toContain('INV-000042')
    // The label the buyer matches against their contract — and the bug this
    // pins: "2 of 37" on any sale that carries a deposit.
    expect(text).toContain('Installment 2 of 36')

    // Every payment allocated to the entry, by its reference, with the amount
    // that landed on *this* installment rather than the payment's own total.
    expect(text).toContain('RCPT-0114')
    expect(text).toContain('MPESA-QG7H2')
    expect(text).toContain('KES 33,333.33')
    expect(text).toContain('2026-03-12')
    expect(text).toContain('Tunde Bakare')
    // A deleted staff account prints as the fallback, not as a crash.
    expect(text).toContain(UNKNOWN_RECORDER)

    // Paid so far and the remainder, both from the entry's own maintained total.
    expect(text).toContain('Paid so far')
    expect(text).toContain('KES 116,666.67')
    expect(text).toContain('Still outstanding')
    expect(text).toContain('KES 66,666.66')

    // Past its due date, and it says so with the date.
    expect(text).toContain('OVERDUE')
    expect(text).toContain('Past due since 2026-03-10')

    // The masthead: org, project, the placeholder logo's initials, and the
    // footer line that tells the buyer what to quote.
    expect(text).toContain('Sunrise Developments')
    expect(text).toContain('Riverside Court')
    expect(text).toContain('SD')
    expect(text).toContain('Please quote this number with your payment')
  })

  it('reads as settled when the installment is fully paid', async () => {
    const { text } = await render({
      amountPaidMinor: 18333333n,
      status: 'PAID',
      payments: [{ ...BASE.payments[0], amountMinor: 18333333n }]
    })

    expect(text).toContain('PAID IN FULL')
    expect(text).toContain('No further payment is due')
    expect(text).toContain('KES 0.00')
  })

  it('calls the deposit a deposit rather than installment zero', async () => {
    const { text } = await render({ sequence: 0, status: 'PAID', amountPaidMinor: 18333333n })

    expect(text).toContain('Deposit')
    expect(text).not.toContain('Installment 0')
  })

  it('says plainly when nothing is allocated, rather than printing an empty table', async () => {
    // Reachable on an invoice whose payment was voided after issuance.
    const { text } = await render({ amountPaidMinor: 0n, status: 'OVERDUE', payments: [] })

    expect(text).toContain('No payments are recorded against this installment')
  })

  it('embeds no fonts, so a buyer on a weak connection downloads kilobytes', async () => {
    const { buffer } = await render()

    // The standard WinAnsi faces are referenced, never embedded — which is also
    // why money reads 'KES 1,234.00' and not with a local currency glyph.
    expect(buffer.toString('latin1')).not.toContain('FontFile')
    expect(buffer.length).toBeLessThan(20_000)
  })
})
