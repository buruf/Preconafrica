import { describe, expect, it } from 'vitest'
import {
  UnsupportedCurrencyError,
  exponentFor,
  formatMinor,
  isSupportedCurrency,
  toMinor
} from '@/domain/currency'

describe('exponentFor', () => {
  it('returns 2 for two-decimal African currencies', () => {
    for (const code of ['NGN', 'KES', 'GHS', 'ZAR', 'EGP', 'MAD', 'TZS']) {
      expect(exponentFor(code)).toBe(2)
    }
  })

  it('returns 0 for zero-decimal African currencies', () => {
    for (const code of ['RWF', 'UGX', 'XOF', 'XAF', 'DJF']) {
      expect(exponentFor(code)).toBe(0)
    }
  })

  it('treats USD as an ordinary entry, not a default', () => {
    expect(exponentFor('USD')).toBe(2)
    expect(isSupportedCurrency('ZZZ')).toBe(false)
    expect(() => exponentFor('ZZZ')).toThrow(UnsupportedCurrencyError)
  })

  it('is case-insensitive', () => {
    expect(exponentFor('ngn')).toBe(2)
  })
})

describe('toMinor', () => {
  it('converts a two-decimal amount', () => {
    expect(toMinor('1250.75', 'NGN')).toBe(125075n)
  })

  it('pads a missing fractional part', () => {
    expect(toMinor('1250.5', 'NGN')).toBe(125050n)
    expect(toMinor('1250', 'NGN')).toBe(125000n)
  })

  it('handles a zero-decimal currency with no scaling', () => {
    expect(toMinor('1250', 'RWF')).toBe(1250n)
  })

  it('handles amounts far beyond Int32', () => {
    expect(toMinor('250000000', 'NGN')).toBe(25_000_000_000n)
  })

  it('strips thousands separators and whitespace', () => {
    expect(toMinor(' 250,000,000.00 ', 'NGN')).toBe(25_000_000_000n)
  })

  it('rejects more fractional digits than the currency allows', () => {
    expect(() => toMinor('10.999', 'NGN')).toThrow(/fractional/i)
    expect(() => toMinor('10.5', 'RWF')).toThrow(/fractional/i)
  })

  it('rejects non-numeric input', () => {
    expect(() => toMinor('abc', 'NGN')).toThrow(/invalid/i)
  })
})

describe('formatMinor', () => {
  it('formats a two-decimal currency with its symbol', () => {
    const out = formatMinor(25_000_000_000n, 'NGN', 'en-NG')
    expect(out).toContain('250,000,000')
    expect(out).toMatch(/NGN|₦/)
  })

  it('formats a zero-decimal currency without decimals', () => {
    const out = formatMinor(1250n, 'RWF', 'en-RW')
    expect(out).toContain('1,250')
    expect(out).not.toContain('.00')
  })

  it('formats negative amounts', () => {
    expect(formatMinor(-125075n, 'NGN', 'en-NG')).toContain('1,250.75')
  })
})
