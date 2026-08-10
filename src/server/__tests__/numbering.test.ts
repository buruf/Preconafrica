import { describe, expect, it } from 'vitest'
import { formatDocumentNumber } from '@/server/documents/numbering'

describe('formatDocumentNumber', () => {
  it('prefixes by type and pads to six digits', () => {
    expect(formatDocumentNumber('INVOICE', 1)).toBe('INV-000001')
    expect(formatDocumentNumber('RECEIPT', 42)).toBe('RCP-000042')
    expect(formatDocumentNumber('STATEMENT', 999_999)).toBe('STM-999999')
  })

  it('does not truncate beyond the padding width', () => {
    expect(formatDocumentNumber('INVOICE', 1_000_000)).toBe('INV-1000000')
  })

  it('rejects a non-positive sequence', () => {
    expect(() => formatDocumentNumber('INVOICE', 0)).toThrow(RangeError)
  })
})
