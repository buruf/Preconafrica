import { describe, expect, it } from 'vitest'
import {
  UnsupportedCurrencyError,
  exponentFor,
  formatMinor,
  isSupportedCurrency,
  toMajorString,
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

  it('keeps every digit of an amount beyond Number.MAX_SAFE_INTEGER', () => {
    // Whole part 9,007,199,254,740,993 = MAX_SAFE_INTEGER + 2, which no float
    // can hold. Formatting used to pass through Number() and printed ...994.00
    // — a figure that does not match what the database stores.
    const amountMinor = 900_719_925_474_099_300n
    expect(amountMinor).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))

    const out = formatMinor(amountMinor, 'NGN', 'en-US')
    expect(out).toContain('9,007,199,254,740,993.00')
    expect(out).not.toContain('994')
  })

  it('keeps every digit of a huge zero-decimal amount', () => {
    const out = formatMinor(90_071_992_547_409_931n, 'UGX', 'en-US')
    expect(out).toContain('90,071,992,547,409,931')
  })
})

describe('toMajorString', () => {
  it('keeps a nonzero remainder for a two-decimal currency', () => {
    expect(toMajorString(100050n, 'NGN')).toBe('1000.50')
  })

  it('pads a zero remainder rather than trimming it', () => {
    expect(toMajorString(100000n, 'NGN')).toBe('1000.00')
  })

  it('has no decimal point for a zero-decimal currency', () => {
    expect(toMajorString(9_500_000n, 'RWF')).toBe('9500000')
  })

  it('formats negative amounts with the sign before the whole part', () => {
    expect(toMajorString(-125075n, 'NGN')).toBe('-1250.75')
  })

  it('round-trips through toMinor for a range of values', () => {
    const cases: Array<[bigint, string]> = [
      [0n, 'NGN'],
      [1n, 'NGN'],
      [100050n, 'NGN'],
      [25_000_000_000n, 'NGN'],
      [1250n, 'RWF'],
      [0n, 'RWF'],
      [9_999_999_999_999n, 'RWF']
    ]

    for (const [amountMinor, code] of cases) {
      expect(toMinor(toMajorString(amountMinor, code), code)).toBe(amountMinor)
    }
  })
})
