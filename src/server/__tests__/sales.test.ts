import { describe, expect, it } from 'vitest'
import { BuyerRegistrationSchema, createSale, previewSchedule, summariseSale } from '@/server/services/sales'
import { constraintTargetIncludes } from '@/server/services/units'
import { AuthorizationError, type SessionActor } from '@/server/session'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

describe('BuyerRegistrationSchema', () => {
  const valid = {
    fullName: 'Amina Yusuf',
    phone: '+2348031234567',
    email: 'amina@example.com',
    address: '14 Admiralty Way, Lekki',
    password: 'password123'
  }

  it('accepts a valid registration', () => {
    expect(BuyerRegistrationSchema.safeParse(valid).success).toBe(true)
  })

  it('accepts a missing address, which is optional', () => {
    const { address, ...withoutAddress } = valid
    expect(BuyerRegistrationSchema.safeParse(withoutAddress).success).toBe(true)
  })

  it('requires full name, phone and email', () => {
    for (const field of ['fullName', 'phone', 'email'] as const) {
      const copy: Record<string, unknown> = { ...valid }
      delete copy[field]
      expect(BuyerRegistrationSchema.safeParse(copy).success, field).toBe(false)
    }
  })

  it('requires E.164 phone format with a country code', () => {
    for (const phone of ['08031234567', '2348031234567', '+234 803 123 4567', '+0803123', 'phone']) {
      expect(BuyerRegistrationSchema.safeParse({ ...valid, phone }).success, phone).toBe(false)
    }
  })

  it('accepts E.164 numbers from several African countries', () => {
    for (const phone of ['+2348031234567', '+254712345678', '+233201234567', '+27821234567', '+250788123456']) {
      expect(BuyerRegistrationSchema.safeParse({ ...valid, phone }).success, phone).toBe(true)
    }
  })

  it('lowercases the email', () => {
    const parsed = BuyerRegistrationSchema.parse({ ...valid, email: 'Amina@Example.COM' })
    expect(parsed.email).toBe('amina@example.com')
  })
})

describe('previewSchedule', () => {
  it('summarises an installment plan without touching the database', () => {
    const preview = previewSchedule({
      planType: 'INSTALLMENTS',
      priceMinor: 100_000n,
      depositMinor: 0n,
      months: 36,
      signedAt: utc(2026, 8, 9)
    })

    expect(preview.entries).toHaveLength(36)
    expect(preview.monthlyMinor).toBe(2_777n)
    expect(preview.finalMinor).toBe(2_805n)
    expect(preview.totalMinor).toBe(100_000n)
  })

  it('reports no monthly figure for a full payment', () => {
    const preview = previewSchedule({
      planType: 'FULL',
      priceMinor: 100_000n,
      depositMinor: 0n,
      months: 0,
      signedAt: utc(2026, 8, 9)
    })

    expect(preview.entries).toHaveLength(1)
    expect(preview.monthlyMinor).toBeNull()
    expect(preview.totalMinor).toBe(100_000n)
  })
})

describe('summariseSale', () => {
  const sale = {
    priceMinor: 900n,
    depositMinor: 0n,
    scheduleEntries: [
      { dueDate: utc(2026, 6, 9), amountDueMinor: 300n, amountPaidMinor: 300n },
      { dueDate: utc(2026, 7, 9), amountDueMinor: 300n, amountPaidMinor: 100n },
      { dueDate: utc(2026, 8, 9), amountDueMinor: 300n, amountPaidMinor: 0n }
    ]
  }

  it('totals what has been paid and what remains', () => {
    const summary = summariseSale(sale, utc(2026, 7, 20))
    expect(summary.paidToDateMinor).toBe(400n)
    expect(summary.balanceMinor).toBe(500n)
  })

  it('counts the deposit as paid to date', () => {
    const summary = summariseSale({ ...sale, depositMinor: 250n }, utc(2026, 7, 20))
    expect(summary.paidToDateMinor).toBe(650n)
  })

  it('reports the oldest unsettled entry as next due', () => {
    const summary = summariseSale(sale, utc(2026, 7, 20))
    expect(summary.nextDue?.dueDate.toISOString().slice(0, 10)).toBe('2026-07-09')
    expect(summary.nextDue?.amountMinor).toBe(200n)
  })

  it('counts overdue entries as of the given date', () => {
    expect(summariseSale(sale, utc(2026, 7, 20)).overdueCount).toBe(1)
    expect(summariseSale(sale, utc(2026, 9, 20)).overdueCount).toBe(2)
    expect(summariseSale(sale, utc(2026, 6, 1)).overdueCount).toBe(0)
  })

  it('reports no next due date once everything is settled', () => {
    const settled = {
      priceMinor: 300n,
      depositMinor: 0n,
      scheduleEntries: [{ dueDate: utc(2026, 6, 9), amountDueMinor: 300n, amountPaidMinor: 300n }]
    }
    const summary = summariseSale(settled, utc(2026, 12, 1))
    expect(summary.nextDue).toBeNull()
    expect(summary.balanceMinor).toBe(0n)
  })
})

describe('constraintTargetIncludes', () => {
  // registerBuyer's P2002 handling and updateUnit's both rely on this to
  // decide whether a unique-constraint violation is the one they think it
  // is. Prisma's `error.meta.target` shape isn't guaranteed across
  // engines/versions, so this must handle string, array, and other shapes
  // defensively rather than assuming one.

  it('matches a single string target', () => {
    expect(constraintTargetIncludes('email', 'email')).toBe(true)
    expect(constraintTargetIncludes('name', 'email')).toBe(false)
  })

  it('matches within an array target', () => {
    expect(constraintTargetIncludes(['orgId', 'email'], 'email')).toBe(true)
    expect(constraintTargetIncludes(['orgId', 'userId'], 'email')).toBe(false)
  })

  it('treats unrecognised shapes as no match, not a crash', () => {
    expect(constraintTargetIncludes(undefined, 'email')).toBe(false)
    expect(constraintTargetIncludes(null, 'email')).toBe(false)
    expect(constraintTargetIncludes(42, 'email')).toBe(false)
  })
})

describe('createSale authorization', () => {
  // These paths are rejected before createSale makes its first database
  // call (assertRole and the buyer-self check both run synchronously), so
  // they are safe to exercise without a database. The success paths for
  // BUYER/ADMIN/AGENT need real Unit/Buyer rows and are covered by the
  // live-database script instead.

  const buyerActor: SessionActor = {
    userId: 'user_buyer_1',
    orgId: 'org_1',
    role: 'BUYER',
    buyerId: 'buyer_1',
    fullName: 'Amina Yusuf',
    email: 'amina@example.com'
  }

  const baseInput = {
    buyerId: 'buyer_1',
    unitId: 'unit_1',
    planType: 'FULL' as const,
    deposit: '0',
    termMonths: 0,
    signedAt: utc(2026, 8, 9)
  }

  it('rejects a BUYER creating a sale for a different buyerId in the same org', async () => {
    await expect(
      createSale(buyerActor, { ...baseInput, buyerId: 'someone-elses-buyer-id' })
    ).rejects.toMatchObject({ name: 'ServiceError', code: 'FORBIDDEN' })
  })

  it('does not disclose whether the other buyerId exists', async () => {
    // Same message and code whether that buyerId is real, someone else's,
    // or gibberish — the check never looks it up.
    const messages = await Promise.all(
      ['a-real-buyer-in-the-org', 'not-a-real-id-at-all'].map((buyerId) =>
        createSale(buyerActor, { ...baseInput, buyerId }).catch((error) => error.message)
      )
    )
    expect(messages[0]).toBe(messages[1])
  })

  it('rejects a role that is neither staff nor buyer', async () => {
    const bogusActor = { ...buyerActor, role: 'SUPERUSER' } as unknown as SessionActor
    await expect(createSale(bogusActor, baseInput)).rejects.toBeInstanceOf(AuthorizationError)
  })
})
