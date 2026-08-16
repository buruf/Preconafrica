import { describe, expect, it } from 'vitest'
import {
  date,
  describeChange,
  diffValues,
  enumValue,
  image,
  money,
  number,
  renderValue,
  sameValue,
  text,
  type AuditFields
} from '@/domain/audit'

/**
 * `Intl.NumberFormat` separates a currency code from its figure with a
 * non-breaking space (U+00A0), so `formatMinor` emits NGN 145,000,000.00.
 * The expected strings below are written with ordinary spaces so they stay
 * readable in this file; that is the only difference between what is asserted
 * and what actually renders.
 */
function plain(value: string): string {
  return value.replace(new RegExp(String.fromCharCode(160), 'g'), ' ')
}

/**
 * The diff is the difference between a log people read and a log people ignore.
 *
 * A unit row has a dozen columns. If an audit entry dumped all of them, a price
 * change would be eleven lines of noise around the one line anybody wanted, and
 * the noise would be identical on every entry — which is how a reader learns to
 * stop looking. So: only what moved, with enough type information to render
 * money as money and an image as "replaced" rather than as a signed URL.
 */

const UNIT: AuditFields = {
  name: text('4C'),
  priceMinor: money(14_500_000_000n, 'NGN'),
  bedrooms: number(3),
  sizeSqm: text('210.00'),
  status: enumValue('AVAILABLE'),
  layoutImageUrl: image(null)
}

describe('diffValues reports only what changed', () => {
  it('reports nothing when nothing moved', () => {
    expect(diffValues(UNIT, { ...UNIT })).toEqual([])
  })

  it('reports the one field that moved and no other', () => {
    const changes = diffValues(UNIT, { ...UNIT, priceMinor: money(14_900_000_000n, 'NGN') })

    expect(changes).toHaveLength(1)
    expect(changes[0].field).toBe('priceMinor')
    // The eleven unchanged fields are absent, not present-and-equal. This is
    // the assertion the whole design exists for.
    expect(changes.map((change) => change.field)).not.toContain('bedrooms')
    expect(changes.map((change) => change.field)).not.toContain('name')
  })

  it('reports several fields when several moved, in the order they are given', () => {
    const changes = diffValues(UNIT, {
      ...UNIT,
      name: text('4C-PH'),
      bedrooms: number(4)
    })

    expect(changes.map((change) => change.field)).toEqual(['name', 'bedrooms'])
  })

  it('carries a BigInt change through as exact minor units with its currency', () => {
    const [change] = diffValues(UNIT, { ...UNIT, priceMinor: money(14_900_000_000n, 'NGN') })

    // A string, because JSON has no BigInt and this ends up in a Json column —
    // and an exact one, because a Number would have rounded a figure this size.
    expect(change.from).toEqual({ kind: 'money', minor: '14500000000', currency: 'NGN' })
    expect(change.to).toEqual({ kind: 'money', minor: '14900000000', currency: 'NGN' })
    expect(BigInt((change.to as { minor: string }).minor)).toBe(14_900_000_000n)
  })

  it('renders a BigInt change as money in the currency it was recorded in', () => {
    const [change] = diffValues(UNIT, { ...UNIT, priceMinor: money(14_900_000_000n, 'NGN') })

    expect(plain(describeChange(change))).toBe('price NGN 145,000,000.00 → NGN 149,000,000.00')
  })

  it('keeps a zero-decimal currency exact rather than assuming two places', () => {
    const before: AuditFields = { priceMinor: money(18_500_000n, 'RWF') }
    const [change] = diffValues(before, { priceMinor: money(19_000_000n, 'RWF') })

    // RWF has no minor unit. Rendering it with two decimals would be 100x out.
    expect(plain(describeChange(change))).toBe('price RWF 18,500,000 → RWF 19,000,000')
  })

  it('reads a null → value change as "none → …" rather than dropping it', () => {
    const before: AuditFields = { note: { kind: 'none' }, priceMinor: money(null, 'NGN') }
    const changes = diffValues(before, {
      note: text('paid in cash at the site office'),
      priceMinor: money(14_500_000_000n, 'NGN')
    })

    expect(changes).toHaveLength(2)
    expect(plain(describeChange(changes[0]))).toBe('note none → paid in cash at the site office')
    expect(plain(describeChange(changes[1]))).toBe('price none → NGN 145,000,000.00')
  })

  it('reads a value → null change the same way, in reverse', () => {
    const [change] = diffValues({ note: text('duplicate') }, { note: text(null) })
    expect(plain(describeChange(change))).toBe('note duplicate → none')
  })

  it('treats a field absent from the before state as absent, not as unchanged', () => {
    // A field the caller only measured afterwards still has to report, or a
    // newly-added column would silently never appear in any entry.
    const changes = diffValues({}, { bedrooms: number(4) })
    expect(changes).toEqual([{ field: 'bedrooms', from: { kind: 'none' }, to: { kind: 'number', value: 4 } }])
  })

  it('ignores fields the after state does not mention', () => {
    // Absent from `after` means "this edit did not touch it", which is not the
    // same as "it was cleared". Reporting it as cleared would make every
    // partial edit look destructive.
    expect(diffValues(UNIT, { bedrooms: number(3) })).toEqual([])
  })

  it('does not confuse an empty string with an absent value, or either with zero', () => {
    expect(sameValue(text(''), { kind: 'none' })).toBe(true)
    expect(sameValue(number(0), { kind: 'none' })).toBe(false)
    expect(sameValue(money(0n, 'NGN'), { kind: 'none' })).toBe(false)
  })

  it('treats the same amount in two currencies as a change', () => {
    // 100 NGN and 100 KES are not the same amount of anything.
    expect(sameValue(money(10_000n, 'NGN'), money(10_000n, 'KES'))).toBe(false)
  })
})

describe('describeChange says an image change in words', () => {
  it('says set, removed and replaced rather than printing a URL', () => {
    const set = diffValues(
      { heroImageUrl: image(null) },
      { heroImageUrl: image('https://cdn.test/a.jpg') }
    )
    const replaced = diffValues(
      { heroImageUrl: image('https://cdn.test/a.jpg') },
      { heroImageUrl: image('https://cdn.test/b.jpg') }
    )
    const removed = diffValues(
      { heroImageUrl: image('https://cdn.test/a.jpg') },
      { heroImageUrl: image(null) }
    )

    expect(plain(describeChange(set[0]))).toBe('building photo set')
    expect(plain(describeChange(replaced[0]))).toBe('building photo replaced')
    expect(plain(describeChange(removed[0]))).toBe('building photo removed')

    // The URL is still in the entry — it is history — it just never reaches a
    // sentence. A signed blob URL in a row of prose is not a sentence.
    expect(set[0].to).toEqual({ kind: 'image', url: 'https://cdn.test/a.jpg' })
    for (const change of [...set, ...replaced, ...removed]) {
      expect(plain(describeChange(change))).not.toContain('https://')
    }
  })
})

describe('renderValue', () => {
  it('says an enum in English rather than shouting it', () => {
    expect(renderValue(enumValue('AVAILABLE'))).toBe('Available')
    expect(renderValue(enumValue('BANK_TRANSFER'))).toBe('Bank transfer')
  })

  it('says a date as a day, never a timestamp', () => {
    expect(renderValue(date(new Date('2026-08-14T09:12:33.412Z')))).toBe('2026-08-14')
  })

  it('says an absent value as "none"', () => {
    expect(renderValue({ kind: 'none' })).toBe('none')
  })
})
