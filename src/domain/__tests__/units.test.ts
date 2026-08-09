import { describe, expect, it } from 'vitest'
import {
  UNIT_PATTERN_PRESETS,
  UnitPatternError,
  columnLetters,
  generateUnitNames
} from '@/domain/units'

const names = (input: Parameters<typeof generateUnitNames>[0]) =>
  generateUnitNames(input).map((u) => u.name)

describe('columnLetters', () => {
  it('maps the first 26 positions to single letters', () => {
    expect(columnLetters(1)).toBe('A')
    expect(columnLetters(26)).toBe('Z')
  })

  it('continues spreadsheet-style past 26 instead of wrapping', () => {
    expect(columnLetters(27)).toBe('AA')
    expect(columnLetters(28)).toBe('AB')
    expect(columnLetters(52)).toBe('AZ')
    expect(columnLetters(53)).toBe('BA')
  })

  it('rejects non-positive and fractional input', () => {
    expect(() => columnLetters(0)).toThrow(RangeError)
    expect(() => columnLetters(-1)).toThrow(RangeError)
    expect(() => columnLetters(1.5)).toThrow(RangeError)
  })
})

describe('generateUnitNames', () => {
  it('generates zero-padded numeric names', () => {
    expect(names({ floors: 2, unitsPerFloor: 3, pattern: '{floor}{index:02}', startFloor: 4 }))
      .toEqual(['401', '402', '403', '501', '502', '503'])
  })

  it('generates letter names', () => {
    expect(names({ floors: 2, unitsPerFloor: 2, pattern: '{floor}{letter}', startFloor: 4 }))
      .toEqual(['4A', '4B', '5A', '5B'])
  })

  it('does not produce duplicates past 26 units on a floor', () => {
    const result = names({ floors: 1, unitsPerFloor: 28, pattern: '{floor}{letter}', startFloor: 1 })
    expect(result[25]).toBe('1Z')
    expect(result[26]).toBe('1AA')
    expect(result[27]).toBe('1AB')
    expect(new Set(result).size).toBe(28)
  })

  it('supports unpadded index and arbitrary literal text', () => {
    expect(names({ floors: 1, unitsPerFloor: 2, pattern: 'Unit {floor}-{index}', startFloor: 2 }))
      .toEqual(['Unit 2-1', 'Unit 2-2'])
  })

  it('supports a padded floor token', () => {
    expect(names({ floors: 1, unitsPerFloor: 1, pattern: 'B{floor:02}{index:02}', startFloor: 7 }))
      .toEqual(['B0701'])
  })

  it('starts numbering from startFloor', () => {
    const units = generateUnitNames({
      floors: 2,
      unitsPerFloor: 1,
      pattern: '{floor}{index:02}',
      startFloor: 10
    })
    expect(units.map((u) => u.floor)).toEqual([10, 11])
    expect(units.map((u) => u.name)).toEqual(['1001', '1101'])
  })

  it('reports the index within each floor', () => {
    const units = generateUnitNames({
      floors: 2,
      unitsPerFloor: 2,
      pattern: '{floor}{index}',
      startFloor: 1
    })
    expect(units.map((u) => u.indexOnFloor)).toEqual([1, 2, 1, 2])
  })

  it('generates every unit for a realistic building', () => {
    expect(
      generateUnitNames({ floors: 12, unitsPerFloor: 8, pattern: '{floor}{index:02}', startFloor: 1 })
    ).toHaveLength(96)
  })

  it('rejects a pattern with no per-unit token, which would duplicate names', () => {
    expect(() =>
      generateUnitNames({ floors: 2, unitsPerFloor: 3, pattern: 'Flat {floor}', startFloor: 1 })
    ).toThrow(UnitPatternError)
  })

  it('rejects an unknown token', () => {
    expect(() =>
      generateUnitNames({ floors: 1, unitsPerFloor: 1, pattern: '{block}{index}', startFloor: 1 })
    ).toThrow(UnitPatternError)
  })

  it('rejects non-positive dimensions', () => {
    const base = { pattern: '{floor}{index:02}', startFloor: 1 }
    expect(() => generateUnitNames({ ...base, floors: 0, unitsPerFloor: 4 })).toThrow(UnitPatternError)
    expect(() => generateUnitNames({ ...base, floors: 4, unitsPerFloor: 0 })).toThrow(UnitPatternError)
    expect(() => generateUnitNames({ ...base, floors: 1.5, unitsPerFloor: 4 })).toThrow(UnitPatternError)
  })

  it('exposes presets that all generate successfully', () => {
    expect(UNIT_PATTERN_PRESETS.length).toBeGreaterThanOrEqual(2)
    for (const preset of UNIT_PATTERN_PRESETS) {
      expect(() =>
        generateUnitNames({ floors: 1, unitsPerFloor: 2, pattern: preset.pattern, startFloor: 4 })
      ).not.toThrow()
    }
  })
})
