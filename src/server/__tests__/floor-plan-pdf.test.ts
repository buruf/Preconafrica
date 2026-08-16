import { createElement } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { describe, expect, it } from 'vitest'
import { FloorPlanDocument, type FloorPlanProps } from '@/server/pdf/FloorPlanDocument'
import { floorPlanFilename } from '@/domain/units'
import { MAX_PDF_IMAGE_BYTES, type PdfImage } from '@/server/media/images'
import { FLOOR_PLAN, LOGO_PNG, extractPdfText, makePng } from '@/server/__tests__/pdf-fixtures'

/**
 * The floor plan document, rendered from local fixtures and never from the
 * database. `createElement` rather than JSX because vitest only collects `.ts`
 * files — the same shape the other document tests use.
 *
 * Two properties matter more than the rest and are asserted from the bytes
 * rather than from the source:
 *
 *  - **It renders with no drawing.** A buyer tapping a link on a unit whose
 *    developer has not uploaded a plan must get a valid, sensible PDF, not a
 *    500 and not a broken file.
 *  - **No money appears on it.** A unit's current price and a signed sale's
 *    snapshotted price are different figures, and one URL serves both staff and
 *    buyers, so a stale amount circulating on a downloadable PDF would be worse
 *    than no amount at all.
 */

const LOGO: PdfImage = { data: LOGO_PNG, format: 'png' }

/** Stands in for the architect's drawing: a real, decodable PNG. */
const PLAN: PdfImage = { data: makePng(200, 7), format: 'png' }

async function render(props: FloorPlanProps): Promise<{ buffer: Buffer; text: string }> {
  const element = createElement(
    FloorPlanDocument as Parameters<typeof createElement>[0],
    props as unknown as Record<string, unknown>
  )
  const buffer = await renderToBuffer(element as Parameters<typeof renderToBuffer>[0])
  return { buffer, text: extractPdfText(buffer) }
}

describe('the floor plan document', () => {
  it('renders a valid PDF with the drawing embedded', async () => {
    const { buffer, text } = await render({ ...FLOOR_PLAN, logo: LOGO, plan: PLAN })

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    // A real document, not a stub: the letterhead is on it.
    expect(text).toContain('Sunrise Developments')
    expect(text).toContain('Riverside Court')
    expect(text).toContain('FLOOR PLAN')
  })

  it('renders a valid PDF when the unit has no drawing, and says so', async () => {
    const { buffer, text } = await render({ ...FLOOR_PLAN, plan: null })

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(text).toContain('NO FLOOR PLAN YET')
    // The empty panel names who to ask rather than leaving a blank rectangle.
    expect(text).toContain('has not uploaded a drawing for this unit')
    // Still the whole document — the facts a reader came for are all present.
    expect(text).toContain('UNIT 4C')
  })

  it('identifies the unit: name, floor, bedrooms and size', async () => {
    const { text } = await render({ ...FLOOR_PLAN, plan: PLAN })

    expect(text).toContain('UNIT 4C')
    expect(text).toContain('BEDROOMS')
    expect(text).toContain('3')
    expect(text).toContain('245.00 m²')
    expect(text).toContain('FLOOR')
    // Context, so a buyer knows what they are looking at and when it is due.
    expect(text).toContain('Riverside Drive, Nairobi')
    expect(text).toContain('2028-06-30')
  })

  it('carries no currency amount anywhere on the page', async () => {
    // Both states, because an empty panel is exactly where a well-meaning
    // "at least show the price" would get added.
    for (const plan of [PLAN, null]) {
      const { text } = await render({ ...FLOOR_PLAN, plan })

      // No ISO code — this app formats money as `NGN 1,234.00` / `KES 1,234.00`.
      expect(text).not.toMatch(/\b(NGN|KES|USD|GHS|UGX|TZS|ZAR)\b/)
      // No grouped figure either: `245.00 m²` is a size and must not trip this,
      // but any realistic price carries thousands separators.
      expect(text).not.toMatch(/\d{1,3}(,\d{3})+/)
    }
  })

  it('embeds no font, so the document stays small enough to download on mobile data', async () => {
    const { buffer } = await render({ ...FLOOR_PLAN, plan: null })

    expect(buffer.toString('latin1')).not.toContain('FontFile')
    // The floor plan is one page of standard faces; everything above this is
    // the drawing, which the image budget governs.
    expect(buffer.length).toBeLessThan(20_000)
  })

  it('stays inside the image budget it is allowed to grow by', async () => {
    const { buffer: bare } = await render({ ...FLOOR_PLAN, plan: null })
    const { buffer: withPlan } = await render({ ...FLOOR_PLAN, logo: LOGO, plan: PLAN })

    expect(withPlan.length).toBeGreaterThan(bare.length)
    // The drawing and the logo are both capped at MAX_PDF_IMAGE_BYTES by
    // `toPdfImage` before they ever reach this component, so the page cannot
    // exceed the bare document plus two budgets plus a little structure.
    expect(withPlan.length).toBeLessThan(bare.length + 2 * MAX_PDF_IMAGE_BYTES)
  })
})

describe('the download filename', () => {
  it('names the unit', () => {
    expect(floorPlanFilename('3B')).toBe('floor-plan-unit-3B.pdf')
  })

  it('cannot break the Content-Disposition header it is interpolated into', () => {
    // A developer types the unit names. A quote would close the header's
    // quoted-string and a newline would split the header outright.
    expect(floorPlanFilename('Penthouse "2"')).toBe('floor-plan-unit-Penthouse-2.pdf')
    expect(floorPlanFilename('A\r\nX-Injected: 1')).toBe('floor-plan-unit-A-X-Injected-1.pdf')
    expect(floorPlanFilename('../../etc/passwd')).toBe('floor-plan-unit-etc-passwd.pdf')
  })

  it('falls back rather than producing a nameless file', () => {
    expect(floorPlanFilename('—')).toBe('floor-plan.pdf')
  })
})
