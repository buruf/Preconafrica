import { describe, expect, it } from 'vitest'
import { CreateProjectSchema } from '@/server/services/projects'

const valid = {
  name: 'Sunrise Heights',
  location: 'Lekki Phase 1, Lagos',
  currency: 'NGN',
  expectedCompletion: '2028-06-30',
  floors: 4,
  unitsPerFloor: 6,
  startFloor: 1,
  namingPattern: '{floor}{index:02}',
  defaultBedrooms: 2,
  defaultSizeSqm: '90.00',
  defaultPrice: '145000000',
  reminderDaysBefore: 7,
  overdueNoticeDaysAfter: 3
}

describe('CreateProjectSchema', () => {
  it('accepts a valid project', () => {
    expect(CreateProjectSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects an unsupported currency', () => {
    expect(CreateProjectSchema.safeParse({ ...valid, currency: 'ZZZ' }).success).toBe(false)
  })

  it('rejects a price with more decimals than the currency allows', () => {
    expect(CreateProjectSchema.safeParse({ ...valid, defaultPrice: '100.999' }).success).toBe(false)
  })

  it('accepts a whole-number price for a zero-decimal currency', () => {
    expect(
      CreateProjectSchema.safeParse({ ...valid, currency: 'RWF', defaultPrice: '95000000' }).success
    ).toBe(true)
  })

  it('rejects a fractional price for a zero-decimal currency', () => {
    expect(
      CreateProjectSchema.safeParse({ ...valid, currency: 'RWF', defaultPrice: '95000000.50' }).success
    ).toBe(false)
  })

  it('rejects a naming pattern that would duplicate names', () => {
    expect(CreateProjectSchema.safeParse({ ...valid, namingPattern: 'Flat {floor}' }).success).toBe(false)
  })

  it('rejects a building larger than 2000 units', () => {
    expect(
      CreateProjectSchema.safeParse({ ...valid, floors: 200, unitsPerFloor: 20 }).success
    ).toBe(false)
  })

  it('rejects zero floors', () => {
    expect(CreateProjectSchema.safeParse({ ...valid, floors: 0 }).success).toBe(false)
  })
})
