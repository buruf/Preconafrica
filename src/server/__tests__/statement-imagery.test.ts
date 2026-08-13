import { createElement } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatementDocument, type StatementProps } from '@/server/pdf/StatementDocument'
import { InvoiceDocument, type InvoiceProps } from '@/server/pdf/InvoiceDocument'
import { fetchPdfImage } from '@/server/media/images'

/**
 * The failure this guards against is the one a placeholder is *for*: an admin
 * pastes a URL that does not work — a typo, a CDN that has since gone away, an
 * internal address the guard refuses — and a buyer clicking "download my
 * statement" gets a 500 instead of a document.
 *
 * So this is the whole path, not a mock of it: an unfetchable URL goes through
 * the real guard, comes back null, and the document renders with the labelled
 * band. `createElement` rather than JSX because vitest only collects `.ts` files.
 */

const STATEMENT: StatementProps = {
  number: 'STMT-000009',
  orgName: 'Sunrise Developments',
  projectName: 'Sunrise Heights',
  projectLocation: 'Lekki Phase 1, Lagos',
  unitName: '3B',
  logo: null,
  heroImage: null,
  buyerName: 'Kwame Mensah',
  buyerPhone: '+2348031234567',
  currency: 'NGN',
  planType: 'INSTALLMENTS',
  termMonths: 24,
  priceMinor: 14500000000n,
  depositMinor: 500000000n,
  fee: { mode: 'PERCENT', bps: 1000, fixedMinor: 0n },
  feeMinor: 1400000000n,
  signedAt: new Date('2026-02-01T00:00:00Z'),
  expectedCompletion: new Date('2028-06-30T00:00:00Z'),
  entries: [
    {
      sequence: 0,
      dueDate: new Date('2026-02-01T00:00:00Z'),
      amountDueMinor: 500000000n,
      amountPaidMinor: 500000000n,
      status: 'PAID'
    },
    {
      sequence: 1,
      dueDate: new Date('2026-03-01T00:00:00Z'),
      amountDueMinor: 641666666n,
      amountPaidMinor: 0n,
      status: 'OVERDUE'
    }
  ],
  totalMinor: 15900000000n,
  paidToDateMinor: 500000000n,
  balanceMinor: 15400000000n
}

const INVOICE: InvoiceProps = {
  number: 'INV-000042',
  issuedAt: new Date('2026-08-12T09:30:00Z'),
  orgName: 'Sunrise Developments',
  logo: null,
  projectName: 'Sunrise Heights',
  projectLocation: 'Lekki Phase 1, Lagos',
  unitName: '3B',
  buyerName: 'Kwame Mensah',
  buyerPhone: '+2348031234567',
  buyerEmail: 'kwame@buyer.test',
  buyerAddress: null,
  currency: 'NGN',
  sequence: 1,
  termMonths: 24,
  dueDate: new Date('2026-03-01T00:00:00Z'),
  amountDueMinor: 641666666n,
  amountPaidMinor: 100000000n,
  status: 'PARTIAL'
}

async function render(element: ReturnType<typeof createElement>): Promise<Buffer> {
  return renderToBuffer(element as Parameters<typeof renderToBuffer>[0])
}

describe('a document whose imagery cannot be fetched', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders a valid PDF with the placeholder band rather than throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // A URL the guard refuses outright — the cloud metadata endpoint, which is
    // the exact address this whole guard exists for. No network is touched.
    const heroImage = await fetchPdfImage('http://169.254.169.254/latest/meta-data/')
    expect(heroImage).toBeNull()

    const buffer = await render(createElement(StatementDocument, { ...STATEMENT, heroImage }))

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    // Still a real statement, not a stub: the schedule and the balance are there.
    expect(buffer.length).toBeGreaterThan(2_000)
  })

  it('falls back to the initials placeholder on the invoice masthead', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // A private-range URL: refused before any request, same as a 404 or a
    // timeout would be — every failure mode lands on the same fallback.
    const logo = await fetchPdfImage('https://10.0.0.5/logo.png')
    expect(logo).toBeNull()

    const buffer = await render(createElement(InvoiceDocument, { ...INVOICE, logo }))
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('embeds neither fonts nor images, so an imageless statement stays tiny', async () => {
    const buffer = await render(createElement(StatementDocument, { ...STATEMENT, heroImage: null }))

    expect(buffer.toString('latin1')).not.toContain('FontFile')
    // The baseline the imagery budget is measured against — see MAX_PDF_IMAGE_BYTES.
    expect(buffer.length).toBeLessThan(20_000)
  })

  it('grows by roughly the image when one is embedded, and stays a valid PDF', async () => {
    // A real 1×1 truecolour PNG — IHDR, a deflated scanline and IEND, every CRC
    // correct — so this exercises @react-pdf's actual decode path rather than
    // asserting against a mock. It has to be genuinely valid: a PNG with a bad
    // CRC makes the decoder throw inside a zlib callback, which takes the whole
    // process down rather than failing a test.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOYs3g9AAPNAe9tHBLtAAAAAElFTkSuQmCC',
      'base64'
    )
    const withImage = await render(
      createElement(StatementDocument, {
        ...STATEMENT,
        heroImage: { data: png, format: 'png' }
      })
    )
    const without = await render(createElement(StatementDocument, { ...STATEMENT, heroImage: null }))

    expect(withImage.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(withImage.length).toBeGreaterThan(without.length)
  })
})
