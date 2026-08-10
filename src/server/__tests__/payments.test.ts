import { describe, expect, it } from 'vitest'
import { RecordPaymentSchema } from '@/server/services/payments'

const valid = {
  saleId: 'sale_1',
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
})
