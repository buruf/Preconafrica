import { describe, expect, it } from 'vitest'
import { CreateProjectSchema } from '@/server/services/projects'
import { UpdateUnitSchema } from '@/server/services/units'

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

describe('UpdateUnitSchema price', () => {
  // Currency-aware validation (e.g. RWF allows zero fractional digits) needs
  // the unit's project loaded, so it cannot live in the schema — only a
  // basic numeric-shape check belongs here. The currency-aware half of this
  // is exercised against the live database, not here.

  it('accepts a whole-number price', () => {
    expect(UpdateUnitSchema.safeParse({ price: '145000000' }).success).toBe(true)
  })

  it('accepts a decimal price', () => {
    expect(UpdateUnitSchema.safeParse({ price: '100.50' }).success).toBe(true)
  })

  it('rejects a non-numeric price', () => {
    expect(UpdateUnitSchema.safeParse({ price: 'abc' }).success).toBe(false)
  })

  it('rejects a price with malformed decimal formatting', () => {
    expect(UpdateUnitSchema.safeParse({ price: '12.34.56' }).success).toBe(false)
  })

  it('rejects an empty price string', () => {
    expect(UpdateUnitSchema.safeParse({ price: '' }).success).toBe(false)
  })

  it('leaves price optional', () => {
    expect(UpdateUnitSchema.safeParse({}).success).toBe(true)
  })
})

describe('CreateProjectSchema — the installment charge', () => {
  it('defaults to nothing when the field is blank or absent', () => {
    // A project that charges nothing for installments is the ordinary case, so
    // an untouched field must not be a validation error.
    const { installmentMarkupPercent, ...withoutField } = { ...valid, installmentMarkupPercent: '' }
    expect(CreateProjectSchema.safeParse(withoutField).success).toBe(true)
    expect(CreateProjectSchema.safeParse({ ...valid, installmentMarkupPercent: '' }).success).toBe(
      true
    )
  })

  it('accepts a percentage with up to two decimal places', () => {
    for (const percent of ['0', '10', '7.5', '12.25', '100']) {
      expect(
        CreateProjectSchema.safeParse({ ...valid, installmentMarkupPercent: percent }).success,
        percent
      ).toBe(true)
    }
  })

  it('rejects a percentage basis points cannot hold exactly', () => {
    // Two decimals is exactly the precision of a basis point. A third would
    // have to be rounded, and a silently rounded rate is a contract that is
    // wrong by a rounding error nobody agreed to.
    for (const percent of ['7.555', '0.001', '-1', '101', '100.01', 'ten']) {
      expect(
        CreateProjectSchema.safeParse({ ...valid, installmentMarkupPercent: percent }).success,
        percent
      ).toBe(false)
    }
  })

  it('names the offending field so the form can point at it', () => {
    const result = CreateProjectSchema.safeParse({ ...valid, installmentMarkupPercent: '7.555' })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.some((issue) => issue.path[0] === 'installmentMarkupPercent')).toBe(
      true
    )
  })
})

describe('CreateProjectSchema — a fixed installment charge', () => {
  // The second mode is a first-class requirement, not a variant: a percentage
  // of the financed amount is interest, and interest is not permissible in
  // several of the markets this platform serves. See `InstallmentFeeMode`.
  const fixedProject = { ...valid, installmentFeeMode: 'FIXED', installmentFixedFee: '2500000' }

  it('defaults to PERCENT when the mode is blank or absent', () => {
    // Every caller that predates FIXED omits the field, and must keep the
    // behaviour it had.
    expect(CreateProjectSchema.parse(valid).installmentFeeMode).toBe('PERCENT')
    expect(CreateProjectSchema.parse({ ...valid, installmentFeeMode: '' }).installmentFeeMode).toBe(
      'PERCENT'
    )
  })

  it('accepts a flat amount in the project currency', () => {
    expect(CreateProjectSchema.safeParse(fixedProject).success).toBe(true)
    // Zero is a project that charges nothing, which is ordinary, not an error.
    expect(
      CreateProjectSchema.safeParse({ ...fixedProject, installmentFixedFee: '0' }).success
    ).toBe(true)
    expect(
      CreateProjectSchema.safeParse({ ...fixedProject, installmentFixedFee: '' }).success
    ).toBe(true)
  })

  it('validates the amount against the project currency, exactly as the price is', () => {
    // Two decimals is fine in NGN and impossible in RWF — the same rule
    // defaultPrice follows, because both are money in the same currency.
    expect(
      CreateProjectSchema.safeParse({ ...fixedProject, installmentFixedFee: '2500000.50' }).success
    ).toBe(true)
    expect(
      CreateProjectSchema.safeParse({
        ...fixedProject,
        currency: 'RWF',
        defaultPrice: '95000000',
        installmentFixedFee: '2500000.50'
      }).success
    ).toBe(false)
  })

  it('rejects a negative or malformed flat amount', () => {
    for (const amount of ['-1', '-2500000', 'lots', '1.2.3']) {
      expect(
        CreateProjectSchema.safeParse({ ...fixedProject, installmentFixedFee: amount }).success,
        amount
      ).toBe(false)
    }
  })

  it('names the offending field so the form can point at it', () => {
    const result = CreateProjectSchema.safeParse({
      ...fixedProject,
      installmentFixedFee: '2500000.999'
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.some((issue) => issue.path[0] === 'installmentFixedFee')).toBe(true)
  })

  it('only validates the field the chosen mode actually uses', () => {
    // A developer switching a project onto a flat fee should not be made to
    // "fix" a percentage nobody is going to charge, and the reverse.
    expect(
      CreateProjectSchema.safeParse({ ...fixedProject, installmentMarkupPercent: '7.555' }).success
    ).toBe(true)
    expect(
      CreateProjectSchema.safeParse({
        ...valid,
        installmentFeeMode: 'PERCENT',
        installmentMarkupPercent: '10',
        installmentFixedFee: 'nonsense'
      }).success
    ).toBe(true)
  })

  it('rejects a mode that does not exist', () => {
    expect(CreateProjectSchema.safeParse({ ...valid, installmentFeeMode: 'ANNUAL' }).success).toBe(
      false
    )
  })
})
