import { describe, expect, it } from 'vitest'
import { bedroomCountsInText, suggestUnitsForPage, type SuggestableUnit } from '@/domain/plan-import'

/**
 * What a page of a developer's PDF appears to be a plan *for*.
 *
 * The rule worth pinning is the refusal: a page that names two bedroom counts,
 * or none, suggests nothing. A floor plate listing six units is exactly that
 * case, and quietly guessing at it would put one unit's drawing on six units.
 */

const UNITS: SuggestableUnit[] = [
  { id: 'u1', bedrooms: 3 },
  { id: 'u2', bedrooms: 3 },
  { id: 'u3', bedrooms: 4 }
]

describe('bedroomCountsInText', () => {
  it('reads a digit', () => {
    expect(bedroomCountsInText('TYPE A — 3 BEDROOM')).toEqual([3])
  })

  it('reads a plural', () => {
    expect(bedroomCountsInText('3 BEDROOMS')).toEqual([3])
  })

  it('reads a hyphenated form', () => {
    expect(bedroomCountsInText('3-BEDROOM APARTMENT')).toEqual([3])
  })

  it('reads the short form', () => {
    expect(bedroomCountsInText('4 BED')).toEqual([4])
  })

  it('reads a spelled-out number', () => {
    expect(bedroomCountsInText('THREE BEDROOM APARTMENT')).toEqual([3])
  })

  it('collapses repeats of the same count', () => {
    expect(bedroomCountsInText('3 BEDROOM — 3 bedroom unit plan')).toEqual([3])
  })

  it('reports both when a page names two', () => {
    expect(bedroomCountsInText('3 BEDROOM and 4 BEDROOM')).toEqual([3, 4])
  })

  it('finds nothing in a floor plate', () => {
    expect(bedroomCountsInText('LEVEL 3 — UNIT 301 302 303 304')).toEqual([])
  })

  it('ignores an implausible count', () => {
    expect(bedroomCountsInText('99 BEDROOM')).toEqual([])
  })
})

describe('suggestUnitsForPage', () => {
  it('suggests every unit with the count the page names', () => {
    expect(suggestUnitsForPage('3 BEDROOM', UNITS)).toEqual(['u1', 'u2'])
  })

  it('suggests nothing when the page names two counts', () => {
    expect(suggestUnitsForPage('3 BEDROOM and 4 BEDROOM', UNITS)).toEqual([])
  })

  it('suggests nothing when the page names none', () => {
    expect(suggestUnitsForPage('LEVEL 3 — UNIT 301 302', UNITS)).toEqual([])
  })

  it('suggests nothing when no unit has that count', () => {
    expect(suggestUnitsForPage('6 BEDROOM', UNITS)).toEqual([])
  })
})
