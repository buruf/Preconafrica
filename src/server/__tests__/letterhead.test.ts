import { createElement } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { describe, expect, it } from 'vitest'
import { InvoiceDocument } from '@/server/pdf/InvoiceDocument'
import { ReceiptDocument } from '@/server/pdf/ReceiptDocument'
import { StatementDocument } from '@/server/pdf/StatementDocument'
import { orgInitials } from '@/server/pdf/Masthead'
import { MAX_PDF_IMAGE_BYTES, type PdfImage } from '@/server/media/images'
import { INVOICE, LOGO_PNG, RECEIPT, STATEMENT, extractPdfText } from '@/server/__tests__/pdf-fixtures'

/**
 * All three documents carry the same letterhead, and the failure this guards
 * against is the one that was live: `Masthead` documented that the other
 * documents "should not drift away from it" while only the invoice used it, so
 * the developer's logo was missing from the statement a buyer keeps and from
 * every receipt. A comment cannot hold that; a render can.
 *
 * Rendered from the local fixtures in `pdf-fixtures`, never from the database.
 */

const LOGO: PdfImage = { data: LOGO_PNG, format: 'png' }

/** Each document with its type word and the props that differ between them. */
const DOCUMENTS = [
  { docType: 'INVOICE', component: InvoiceDocument, props: INVOICE, number: INVOICE.number },
  { docType: 'STATEMENT', component: StatementDocument, props: STATEMENT, number: STATEMENT.number },
  { docType: 'RECEIPT', component: ReceiptDocument, props: RECEIPT, number: RECEIPT.number }
] as const

async function render(
  component: (typeof DOCUMENTS)[number]['component'],
  props: Record<string, unknown>
): Promise<{ buffer: Buffer; text: string }> {
  // `createElement` rather than JSX because vitest only collects `.ts` files; the
  // cast is the type-only difference between this and a `.tsx` call site.
  const element = createElement(
    component as Parameters<typeof createElement>[0],
    props as Record<string, unknown>
  )
  const buffer = await renderToBuffer(element as Parameters<typeof renderToBuffer>[0])
  return { buffer, text: extractPdfText(buffer) }
}

describe('the letterhead every document shares', () => {
  it.each(DOCUMENTS)('names the org, the document type and its number on a $docType', async (doc) => {
    const { text } = await render(doc.component, { ...doc.props, logo: null })

    expect(text).toContain('Sunrise Developments')
    expect(text).toContain(doc.docType)
    expect(text).toContain(doc.number)
    // No logo set, so the bordered initials stand in — the same 46×46 slot, so a
    // developer who has uploaded nothing gets a deliberate mark and not a hole.
    expect(text).toContain(orgInitials('Sunrise Developments'))
  })

  it.each(DOCUMENTS)('keeps its own identity below the masthead on a $docType', async (doc) => {
    // The header changed; the documents did not. Each still says the thing it
    // exists to say, which is what stops "share the letterhead" becoming
    // "make the three documents the same document".
    const { text } = await render(doc.component, { ...doc.props, logo: LOGO })

    expect(text).toContain('Riverside Court')
    if (doc.docType === 'INVOICE') {
      expect(text).toContain('Installment 2 of 36')
      expect(text).toContain('Still outstanding')
    }
    if (doc.docType === 'STATEMENT') {
      expect(text).toContain('Total owed')
      expect(text).toContain('Expected completion')
    }
    if (doc.docType === 'RECEIPT') {
      expect(text).toContain('Received from')
      expect(text).toContain('Amount received')
    }
  })

  it.each(DOCUMENTS)('embeds a real logo on a $docType, for about what one costs', async (doc) => {
    const withLogo = await render(doc.component, { ...doc.props, logo: LOGO })
    const without = await render(doc.component, { ...doc.props, logo: null })

    expect(withLogo.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')

    // The byte budget, which is the reason this change was cheap: a ~9.5 kB logo
    // adds about its own size to each document, well inside the 300 kB cap that
    // `toPdfImage` enforces on any single image.
    const added = withLogo.buffer.length - without.buffer.length
    expect(added).toBeGreaterThan(LOGO_PNG.length * 0.9)
    expect(added).toBeLessThan(LOGO_PNG.length * 1.3)
    expect(added).toBeLessThan(MAX_PDF_IMAGE_BYTES)
  })

  it.each(DOCUMENTS)('stays kilobytes and embeds no fonts on a $docType', async (doc) => {
    const { buffer } = await render(doc.component, { ...doc.props, logo: null })

    // The standard WinAnsi faces are referenced, never embedded — which is also
    // why money reads 'KES 1,234.00' rather than with a local currency glyph.
    expect(buffer.toString('latin1')).not.toContain('FontFile')
    expect(buffer.length).toBeLessThan(20_000)
  })

  it.each(DOCUMENTS)('renders the initials fallback on a $docType when a logo fetch failed', async (doc) => {
    // Null is every failure mode at once: no logo set, a refused URL, a timeout,
    // a 404, an oversize image, a format a PDF cannot carry. All of them have to
    // land on a document rather than on a 500.
    const { buffer, text } = await render(doc.component, { ...doc.props, logo: null })

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(text).toContain('SD')
  })
})
