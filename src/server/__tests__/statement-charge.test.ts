import { createElement } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { describe, expect, it } from 'vitest'
import { StatementDocument, type StatementProps } from '@/server/pdf/StatementDocument'
import { STATEMENT, extractPdfText } from '@/server/__tests__/pdf-fixtures'

/**
 * The installment charge, as it prints on the buyer's own copy.
 *
 * The rule this pins is the one written out on `InstallmentFeeMode` in
 * schema.prisma and on `installmentFeeRateSuffix`: a FIXED charge is a flat fee,
 * it is not a percentage of anything, and a percentage must never appear beside
 * it. A developer chooses FIXED precisely because a rate on the financed amount
 * is interest and interest is not permissible in their market — printing them a
 * derived rate on the document their buyer keeps would defeat the whole mode.
 *
 * Only a real render catches it. The label helper is unit-tested elsewhere; what
 * this asserts is that the *document* uses it, in both modes, and still names
 * the deposit and the agreed term correctly while doing so.
 *
 * `createElement` rather than JSX because vitest only collects `.ts` files —
 * see the note in `invoice-pdf.test.ts`.
 */

async function render(props: Partial<StatementProps>) {
  const element = createElement(StatementDocument, { ...STATEMENT, ...props })
  const buffer = await renderToBuffer(element as Parameters<typeof renderToBuffer>[0])
  return { buffer, text: extractPdfText(buffer) }
}

describe('the statement’s installment charge', () => {
  it('quotes the rate for a percentage charge', async () => {
    const { text } = await render({
      fee: { mode: 'PERCENT', bps: 1000, fixedMinor: 0n },
      feeMinor: 1_400_000_000n
    })

    expect(text).toContain('Installment charge (10%)')
    expect(text).toContain('KES 14,000,000.00')
  })

  it('quotes no rate whatsoever beside a fixed charge', async () => {
    const { text } = await render({
      fee: { mode: 'FIXED', bps: 0, fixedMinor: 250_000_000n },
      feeMinor: 250_000_000n
    })

    expect(text).toContain('Installment charge')
    expect(text).toContain('KES 2,500,000.00')
    // No percentage anywhere on the page — not the project's stored rate, not
    // one derived from the fee over the financed amount, not any at all.
    expect(text).not.toMatch(/\d\s*%/)
    expect(text).not.toContain('%')
  })

  it('names the deposit and counts the agreed term, in both modes', async () => {
    for (const fee of [
      { mode: 'PERCENT' as const, bps: 1000, fixedMinor: 0n },
      { mode: 'FIXED' as const, bps: 0, fixedMinor: 250_000_000n }
    ]) {
      const { text } = await render({ fee, feeMinor: 250_000_000n })

      // 'Deposit', never 'installment 0' — sequence 0 is the signing-day amount.
      expect(text).toContain('Deposit (due at signing)')
      expect(text).toContain('Deposit')
      expect(text).not.toContain('Installment 0')
      // The denominator is `termMonths` off the sale (24), not `entries.length`
      // (2 in this fixture) — the bug that printed '37 monthly installments' on
      // every 36-month contract that carried a deposit.
      expect(text).toContain('24 monthly installments')
    }
  })

  it('stays kilobytes and embeds no font, whichever mode it prints', async () => {
    for (const fee of [
      { mode: 'PERCENT' as const, bps: 1000, fixedMinor: 0n },
      { mode: 'FIXED' as const, bps: 0, fixedMinor: 250_000_000n }
    ]) {
      const { buffer } = await render({ fee, feeMinor: 250_000_000n })

      // Standard WinAnsi faces referenced, never embedded — which is also why
      // money reads 'KES 1,234.00' rather than with a local currency glyph.
      expect(buffer.toString('latin1')).not.toContain('FontFile')
      expect(buffer.length).toBeLessThan(20_000)
    }
  })
})
