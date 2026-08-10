export class UnsupportedCurrencyError extends Error {
  constructor(code: string) {
    super(`Unsupported currency code: ${code}`)
    this.name = 'UnsupportedCurrencyError'
  }
}

/**
 * ISO-4217 minor-unit exponents. Not every currency has two decimals —
 * RWF, UGX, XOF, XAF and DJF have none, and assuming 2 would inflate every
 * amount in those markets by 100x. USD is one row here, never a fallback.
 */
export const SUPPORTED_CURRENCIES: Readonly<Record<string, number>> = Object.freeze({
  NGN: 2, KES: 2, GHS: 2, ZAR: 2, EGP: 2, MAD: 2, TZS: 2,
  RWF: 0, UGX: 0, XOF: 0, XAF: 0, DJF: 0,
  USD: 2, EUR: 2, GBP: 2
})

function normalize(code: string): string {
  return code.trim().toUpperCase()
}

export function isSupportedCurrency(code: string): boolean {
  return normalize(code) in SUPPORTED_CURRENCIES
}

export function exponentFor(code: string): number {
  const key = normalize(code)
  const exponent = SUPPORTED_CURRENCIES[key]
  if (exponent === undefined) throw new UnsupportedCurrencyError(code)
  return exponent
}

/**
 * Parses a human-entered major-unit string into exact minor units.
 * String input, not number — a float cannot represent 250000000.10 exactly.
 */
export function toMinor(major: string, code: string): bigint {
  const exponent = exponentFor(code)
  const cleaned = major.replace(/[\s,_]/g, '')
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(cleaned)
  if (!match) throw new Error(`Invalid amount: ${major}`)

  const [, sign, whole, fraction = ''] = match
  if (fraction.length > exponent) {
    throw new Error(
      `Amount ${major} has ${fraction.length} fractional digits but ${normalize(code)} allows ${exponent}`
    )
  }

  const padded = fraction.padEnd(exponent, '0')
  const magnitude = BigInt(whole + padded)
  return sign === '-' ? -magnitude : magnitude
}

/**
 * Renders exact minor units as the major-unit decimal string an edit form
 * should prefill — e.g. 100050n for NGN -> "1000.50". Unlike formatMinor,
 * this has no locale/symbol dressing and always keeps the full fractional
 * digits (no trimming trailing zeros), so toMinor(toMajorString(x, c), c)
 * round-trips exactly back to x. Integer division alone (amountMinor /
 * 10n ** exponent) would silently truncate the fraction — that's the bug
 * this function exists to avoid.
 */
export function toMajorString(amountMinor: bigint, code: string): string {
  const currency = normalize(code)
  const exponent = exponentFor(currency)
  const negative = amountMinor < 0n
  const magnitude = negative ? -amountMinor : amountMinor

  const divisor = 10n ** BigInt(exponent)
  const whole = magnitude / divisor
  const fraction = magnitude % divisor

  const numeric =
    exponent === 0 ? whole.toString() : `${whole}.${fraction.toString().padStart(exponent, '0')}`

  return negative ? `-${numeric}` : numeric
}

export function formatMinor(amountMinor: bigint, code: string, locale = 'en-US'): string {
  const currency = normalize(code)
  const exponent = exponentFor(currency)
  const negative = amountMinor < 0n
  const magnitude = negative ? -amountMinor : amountMinor

  const divisor = 10n ** BigInt(exponent)
  const whole = magnitude / divisor
  const fraction = magnitude % divisor

  const numeric =
    exponent === 0
      ? whole.toString()
      : `${whole}.${fraction.toString().padStart(exponent, '0')}`

  // The decimal string goes to Intl as-is. `Number(numeric)` was the one place
  // exact money still round-tripped through a float: an amount above
  // Number.MAX_SAFE_INTEGER minor units (entirely reachable in NGN or UGX)
  // came back with its low-order digits rounded, so the figure shown to a
  // buyer could differ from the figure stored. Intl.NumberFormat accepts a
  // numeric string and formats its digits exactly, with no 2^53 ceiling.
  //
  // The cast is to `Intl.StringNumericLiteral`, a template-literal type no
  // ordinary `string` can satisfy. It is sound here because this function
  // builds `signed` itself, digit by digit, out of BigInt division — it is
  // always `-?\d+(\.\d+)?` and never user input.
  const signed = (negative ? `-${numeric}` : numeric) as Intl.StringNumericLiteral

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent
  }).format(signed)
}
