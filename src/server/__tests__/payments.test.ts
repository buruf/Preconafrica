import { describe, expect, it } from 'vitest'
import { RecordPaymentSchema } from '@/server/services/payments'

const valid = {
  saleId: 'sale_1',
  scheduleEntryId: 'entry_1',
  amount: '250000',
  receivedAt: '2026-08-09',
  method: 'BANK_TRANSFER',
  reference: 'GTB/2026/08/0021',
  note: ''
}

describe('RecordPaymentSchema', () => {
  it('accepts a valid payment', () => {
    expect(RecordPaymentSchema.safeParse(valid).success).toBe(true)
  })

  it('refuses to parse a payment that names no schedule entry', () => {
    // The form cannot submit without a choice, and neither can anything else
    // that posts to the action. There is no default and no "apply it wherever
    // it fits" mode: a payment goes where a person put it.
    const { scheduleEntryId, ...withoutEntry } = valid
    expect(RecordPaymentSchema.safeParse(withoutEntry).success).toBe(false)
    expect(RecordPaymentSchema.safeParse({ ...valid, scheduleEntryId: '' }).success).toBe(false)
  })

  it('says what to do about a missing entry rather than naming the field', () => {
    const parsed = RecordPaymentSchema.safeParse({ ...valid, scheduleEntryId: '' })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe('Choose which payment this settles')
    }
  })

  it('rejects a zero or negative amount', () => {
    expect(RecordPaymentSchema.safeParse({ ...valid, amount: '0' }).success).toBe(false)
    expect(RecordPaymentSchema.safeParse({ ...valid, amount: '-100' }).success).toBe(false)
  })

  it('rejects a non-numeric amount', () => {
    expect(RecordPaymentSchema.safeParse({ ...valid, amount: 'lots' }).success).toBe(false)
  })

  it('rejects an unknown payment method', () => {
    expect(RecordPaymentSchema.safeParse({ ...valid, method: 'CRYPTO' }).success).toBe(false)
  })

  it('accepts every supported method', () => {
    for (const method of ['BANK_TRANSFER', 'MOBILE_MONEY', 'CASH', 'CHEQUE', 'OTHER']) {
      expect(RecordPaymentSchema.safeParse({ ...valid, method }).success, method).toBe(true)
    }
  })

  it('allows an omitted reference for cash', () => {
    const { reference, ...withoutReference } = valid
    expect(
      RecordPaymentSchema.safeParse({ ...withoutReference, method: 'CASH' }).success
    ).toBe(true)
  })

  it('rejects an invalid date', () => {
    expect(RecordPaymentSchema.safeParse({ ...valid, receivedAt: 'yesterday' }).success).toBe(false)
  })

  it('accepts any number of decimal places, because the schema cannot know the currency', () => {
    // Shape only. RWF/UGX/XOF/XAF/DJF allow zero decimals and NGN allows two,
    // and which applies depends on the sale being paid — so "100.5" is a
    // question for recordPayment (via toMinor), not for this regex. Hardcoding
    // \d{1,2} here turned a zero-decimal mistake into an uncaught 500.
    for (const amount of ['100', '100.5', '100.50', '100.500']) {
      expect(RecordPaymentSchema.safeParse({ ...valid, amount }).success, amount).toBe(true)
    }
  })

  it('still rejects malformed numbers', () => {
    for (const amount of ['', '.5', '1.', '1.2.3', '1,000', '1e3', ' 100']) {
      expect(RecordPaymentSchema.safeParse({ ...valid, amount }).success, amount).toBe(false)
    }
  })

  it('rejects an amount that is only zeros, at any precision', () => {
    for (const amount of ['0', '0.0', '000', '0.000']) {
      expect(RecordPaymentSchema.safeParse({ ...valid, amount }).success, amount).toBe(false)
    }
    expect(RecordPaymentSchema.safeParse({ ...valid, amount: '0.001' }).success).toBe(true)
  })

  it('accepts an amount too large for a float to hold exactly', () => {
    // 250,000,000.10 NGN is a real unit price in the seed data. Number() would
    // round it; the schema must not be the thing that loses the kobo.
    expect(RecordPaymentSchema.safeParse({ ...valid, amount: '9007199254740993.01' }).success).toBe(true)
  })
})
