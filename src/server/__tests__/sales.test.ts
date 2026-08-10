import { describe, expect, it } from 'vitest'
import { BuyerRegistrationSchema, PlanSelectionSchema, createSale, previewSchedule, summariseSale } from '@/server/services/sales'
import { buildArrearsRows } from '@/server/services/arrears'
import { constraintTargetIncludes } from '@/server/services/units'
import { AuthorizationError, type SessionActor } from '@/server/session'
import { ScheduleError, generateSchedule } from '@/domain/schedule'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
const day = (d: Date) => d.toISOString().slice(0, 10)

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
  const preview = (over: Partial<Parameters<typeof previewSchedule>[0]> = {}) =>
    previewSchedule({
      planType: 'INSTALLMENTS',
      priceMinor: 100_000n,
      depositMinor: 0n,
      markupBps: 0,
      months: 36,
      signedAt: utc(2026, 8, 9),
      ...over
    })

  it('summarises an installment plan without touching the database', () => {
    const result = preview()

    expect(result.entries).toHaveLength(36)
    expect(result.monthlyMinor).toBe(2_777n)
    expect(result.finalMinor).toBe(2_805n)
    expect(result.totalMinor).toBe(100_000n)
    expect(result.markupMinor).toBe(0n)
  })

  it('reports the monthly figures for the months, not for the deposit', () => {
    // 100,000 with a 28,000 deposit finances 72,000 over 36 months: 2,000 a
    // month exactly. The deposit is entry 0 and must not be mistaken for the
    // monthly amount — the whole point of picking from sequence >= 1.
    const result = preview({ depositMinor: 28_000n })

    expect(result.entries).toHaveLength(37)
    expect(result.entries[0].amountDueMinor).toBe(28_000n)
    expect(result.monthlyMinor).toBe(2_000n)
    expect(result.finalMinor).toBe(2_000n)
    // The new invariant: the schedule is the whole contract.
    expect(result.totalMinor).toBe(100_000n)
  })

  it('still reports the uneven final installment when a deposit is present', () => {
    // 100,001 with a 1 deposit finances 100,000: 2,777 a month, 2,805 last.
    const result = preview({ priceMinor: 100_001n, depositMinor: 1n })

    expect(result.monthlyMinor).toBe(2_777n)
    expect(result.finalMinor).toBe(2_805n)
    expect(result.totalMinor).toBe(100_001n)
  })

  it('surfaces the installment charge as its own figure', () => {
    // 100,000 with a 20,000 deposit finances 80,000; 10% of that is 8,000, so
    // 88,000 is amortized over 36 months and the total owed is 108,000. A UI can
    // print "Installment charge: 8,000" without re-deriving it — and the buyer
    // can see why the total exceeds the price.
    const result = preview({ depositMinor: 20_000n, markupBps: 1_000 })

    expect(result.markupMinor).toBe(8_000n)
    expect(result.totalMinor).toBe(108_000n)
    expect(result.totalMinor).toBe(100_000n + result.markupMinor)
    // 88,000 / 36 = 2,444.44… → 2,444 a month, remainder on the last.
    expect(result.monthlyMinor).toBe(2_444n)
    expect(result.finalMinor).toBe(88_000n - 2_444n * 35n)
    // Still not the deposit.
    expect(result.entries[0].amountDueMinor).toBe(20_000n)
  })

  it('charges nothing on a full payment', () => {
    const result = preview({ planType: 'FULL', months: 0 })

    expect(result.entries).toHaveLength(1)
    expect(result.monthlyMinor).toBeNull()
    expect(result.totalMinor).toBe(100_000n)
    expect(result.markupMinor).toBe(0n)
  })

  it('refuses to preview a markup it would never be able to write', () => {
    // The preview and createSale share generateSchedule precisely so a plan the
    // buyer is shown is a plan that can actually be signed.
    expect(() => preview({ markupBps: 10_001 })).toThrow(ScheduleError)
    expect(() => preview({ planType: 'FULL', months: 0, markupBps: 1_000 })).toThrow(ScheduleError)
  })
})

describe('summariseSale', () => {
  // No `priceMinor` on any of these: the schedule is now the whole statement of
  // what is owed, which is what lets a marked-up sale report the right balance.
  const sale = {
    scheduleEntries: [
      { dueDate: utc(2026, 6, 9), amountDueMinor: 300n, amountPaidMinor: 300n },
      { dueDate: utc(2026, 7, 9), amountDueMinor: 300n, amountPaidMinor: 100n },
      { dueDate: utc(2026, 8, 9), amountDueMinor: 300n, amountPaidMinor: 0n }
    ]
  }

  it('totals what has been paid and what remains', () => {
    const summary = summariseSale(sale, utc(2026, 7, 20))
    expect(summary.totalOwedMinor).toBe(900n)
    expect(summary.paidToDateMinor).toBe(400n)
    expect(summary.balanceMinor).toBe(500n)
  })

  it('counts an unpaid deposit entry as owed, not as paid', () => {
    // The deposit is entry 0 of the schedule, due at signing, and nothing has
    // been allocated to it. Before this change the sale's depositMinor was
    // simply added to paid-to-date, so this buyer read 200 of 900 paid having
    // paid nothing at all.
    const unpaidDeposit = {
      scheduleEntries: [
        { dueDate: utc(2026, 5, 9), amountDueMinor: 200n, amountPaidMinor: 0n },
        { dueDate: utc(2026, 6, 9), amountDueMinor: 350n, amountPaidMinor: 0n },
        { dueDate: utc(2026, 7, 9), amountDueMinor: 350n, amountPaidMinor: 0n }
      ]
    }
    const summary = summariseSale(unpaidDeposit, utc(2026, 5, 10))
    expect(summary.paidToDateMinor).toBe(0n)
    expect(summary.balanceMinor).toBe(900n)
    // Signing was the 9th, so by the 10th the unpaid deposit is already the
    // next thing due and already overdue.
    expect(summary.nextDue?.dueDate.toISOString().slice(0, 10)).toBe('2026-05-09')
    expect(summary.nextDue?.amountMinor).toBe(200n)
    expect(summary.overdueCount).toBe(1)
  })

  it('counts a paid deposit entry once, through its allocation', () => {
    const paidDeposit = {
      scheduleEntries: [
        { dueDate: utc(2026, 5, 9), amountDueMinor: 200n, amountPaidMinor: 200n },
        { dueDate: utc(2026, 6, 9), amountDueMinor: 350n, amountPaidMinor: 0n },
        { dueDate: utc(2026, 7, 9), amountDueMinor: 350n, amountPaidMinor: 0n }
      ]
    }
    const summary = summariseSale(paidDeposit, utc(2026, 5, 10))
    expect(summary.paidToDateMinor).toBe(200n)
    expect(summary.balanceMinor).toBe(700n)
    expect(summary.overdueCount).toBe(0)
  })

  it('owes the markup as well as the price on a marked-up sale', () => {
    // The reason total-owed comes from the schedule and not from priceMinor. This
    // is a real 100,000 sale with a 20,000 deposit at 10%: 108,000 owed. Anchored
    // to the price it would report 100,000, so a buyer who paid every installment
    // but the last would read a zero balance while 8,000 of charge was unpaid —
    // and the sale would look settled to staff.
    const entries = generateSchedule({
      planType: 'INSTALLMENTS',
      priceMinor: 100_000n,
      depositMinor: 20_000n,
      markupBps: 1_000,
      months: 36,
      signedAt: utc(2026, 8, 9)
    }).map((entry) => ({ ...entry, amountPaidMinor: 0n }))

    const unpaid = summariseSale({ scheduleEntries: entries }, utc(2026, 8, 9))
    expect(unpaid.totalOwedMinor).toBe(108_000n)
    expect(unpaid.balanceMinor).toBe(108_000n)

    // Everything settled but the final installment.
    const nearlyDone = entries.map((entry, index) =>
      index === entries.length - 1 ? entry : { ...entry, amountPaidMinor: entry.amountDueMinor }
    )
    const summary = summariseSale({ scheduleEntries: nearlyDone }, utc(2030, 1, 1))
    expect(summary.balanceMinor).toBe(entries[entries.length - 1].amountDueMinor)
    expect(summary.balanceMinor).toBeGreaterThan(0n)
    expect(summary.nextDue?.amountMinor).toBe(entries[entries.length - 1].amountDueMinor)

    // And settling it lands exactly on zero — no rounding crumb left behind.
    const done = entries.map((entry) => ({ ...entry, amountPaidMinor: entry.amountDueMinor }))
    const settled = summariseSale({ scheduleEntries: done }, utc(2030, 1, 1))
    expect(settled.paidToDateMinor).toBe(108_000n)
    expect(settled.balanceMinor).toBe(0n)
    expect(settled.nextDue).toBeNull()
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

  it('reads a fully settled schedule as exactly paid off', () => {
    // The new invariant makes this the ordinary end state: the schedule sums to
    // the price, so settling every entry — deposit included — lands paid-to-date
    // on the price exactly, with nothing left over and nothing missing.
    const settled = {
      scheduleEntries: [
        { dueDate: utc(2026, 5, 9), amountDueMinor: 300n, amountPaidMinor: 300n },
        { dueDate: utc(2026, 6, 9), amountDueMinor: 300n, amountPaidMinor: 300n },
        { dueDate: utc(2026, 7, 9), amountDueMinor: 300n, amountPaidMinor: 300n }
      ]
    }
    const summary = summariseSale(settled, utc(2026, 9, 1))
    expect(summary.paidToDateMinor).toBe(900n)
    expect(summary.balanceMinor).toBe(0n)
    expect(summary.nextDue).toBeNull()
  })

  it('clamps the balance at zero rather than reporting a negative one', () => {
    // No longer reachable through the services: allocation never exceeds an
    // entry's due, so paid-to-date cannot pass total-owed. The clamp stays
    // because this function does not own the rows it is handed — a hand-repaired
    // sale must never show a buyer a negative balance, and nothing downstream
    // should have to guard against one.
    const overpaid = {
      scheduleEntries: [
        { dueDate: utc(2026, 6, 9), amountDueMinor: 300n, amountPaidMinor: 700n },
        { dueDate: utc(2026, 7, 9), amountDueMinor: 300n, amountPaidMinor: 300n },
        { dueDate: utc(2026, 8, 9), amountDueMinor: 300n, amountPaidMinor: 300n }
      ]
    }
    const summary = summariseSale(overpaid, utc(2026, 9, 1))
    expect(summary.paidToDateMinor).toBe(1300n)
    expect(summary.balanceMinor).toBe(0n)
  })

  it('finds the oldest unsettled entry even when the entries arrive out of order', () => {
    // The caller's ordering is not trusted — next-due is defined by due date,
    // so the summary sorts before it picks.
    const shuffled = {
      ...sale,
      scheduleEntries: [sale.scheduleEntries[2], sale.scheduleEntries[0], sale.scheduleEntries[1]]
    }
    const summary = summariseSale(shuffled, utc(2026, 7, 20))
    expect(summary.nextDue?.dueDate.toISOString().slice(0, 10)).toBe('2026-07-09')
    expect(summary.nextDue?.amountMinor).toBe(200n)
  })

  it('reports no next due date once everything is settled', () => {
    const settled = {
      scheduleEntries: [{ dueDate: utc(2026, 6, 9), amountDueMinor: 300n, amountPaidMinor: 300n }]
    }
    const summary = summariseSale(settled, utc(2026, 12, 1))
    expect(summary.nextDue).toBeNull()
    expect(summary.balanceMinor).toBe(0n)
  })
})

describe('an unpaid deposit is arrears', () => {
  // The point of the whole redesign, end to end through the pure functions: a
  // buyer who agreed a 2,000,000 deposit and paid nothing is exposed, not
  // congratulated. Under the old model this sale reported 2,000,000 paid, a
  // balance short by the deposit, and appeared nowhere in the arrears report.
  const signedAt = utc(2026, 8, 9)
  const entries = generateSchedule({
    planType: 'INSTALLMENTS',
    priceMinor: 10_000_000n,
    depositMinor: 2_000_000n,
    markupBps: 1_000,
    months: 36,
    signedAt
  }).map((entry) => ({ ...entry, amountPaidMinor: 0n }))

  const arrearsSale = {
    id: 'sale_1',
    currency: 'NGN',
    buyer: { fullName: 'Amina Yusuf', phone: '+2348031234567', email: 'amina@example.com' },
    project: { name: 'Lekki Gardens' },
    unit: { name: 'A-0101' },
    scheduleEntries: entries
  }

  it('is the next thing due, for its full agreed amount', () => {
    const summary = summariseSale({ scheduleEntries: entries }, signedAt)
    expect(summary.paidToDateMinor).toBe(0n)
    expect(summary.nextDue?.amountMinor).toBe(2_000_000n)
    expect(day(summary.nextDue!.dueDate)).toBe('2026-08-09')
    // Price 10,000,000 + 10% of the financed 8,000,000.
    expect(summary.totalOwedMinor).toBe(10_800_000n)
    expect(summary.balanceMinor).toBe(10_800_000n)
  })

  it('is not yet overdue on the signing day itself', () => {
    expect(summariseSale({ scheduleEntries: entries }, signedAt).overdueCount).toBe(0)
    expect(buildArrearsRows([arrearsSale], signedAt)).toEqual([])
  })

  it('shows in the arrears report two days after signing', () => {
    const asOf = utc(2026, 8, 11)
    const rows = buildArrearsRows([arrearsSale], asOf)

    expect(rows).toHaveLength(1)
    expect(rows[0].overdueCount).toBe(1)
    expect(rows[0].overdueAmountMinor).toBe(2_000_000n)
    expect(day(rows[0].oldestDueDate)).toBe('2026-08-09')
    expect(rows[0].daysLate).toBe(2)
    // No installment has come due yet — the deposit alone is what exposes this
    // buyer, a full month before the first monthly payment.
    expect(summariseSale({ scheduleEntries: entries }, asOf).overdueCount).toBe(1)
  })

  it('drops out of arrears once the deposit is allocated against', () => {
    const paid = entries.map((entry, index) =>
      index === 0 ? { ...entry, amountPaidMinor: entry.amountDueMinor } : entry
    )
    const asOf = utc(2026, 8, 11)
    expect(buildArrearsRows([{ ...arrearsSale, scheduleEntries: paid }], asOf)).toEqual([])

    const summary = summariseSale({ scheduleEntries: paid }, asOf)
    expect(summary.paidToDateMinor).toBe(2_000_000n)
    expect(summary.balanceMinor).toBe(8_800_000n)
    expect(day(summary.nextDue!.dueDate)).toBe('2026-09-09')
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

describe('PlanSelectionSchema normalisation', () => {
  it('treats a blank deposit as zero and a blank term as the default', () => {
    const parsed = PlanSelectionSchema.parse({
      unitId: 'u1',
      planType: 'INSTALLMENTS',
      deposit: '',
      termMonths: ''
    })
    expect(parsed.deposit).toBe('0')
    expect(parsed.termMonths).toBe(36)
  })

  it('trims a padded deposit', () => {
    const parsed = PlanSelectionSchema.parse({
      unitId: 'u1',
      planType: 'INSTALLMENTS',
      deposit: ' 5000000 ',
      termMonths: '24'
    })
    expect(parsed.deposit).toBe('5000000')
    expect(parsed.termMonths).toBe(24)
  })

  it('forces deposit to zero for a FULL plan regardless of input', () => {
    const parsed = PlanSelectionSchema.parse({
      unitId: 'u1',
      planType: 'FULL',
      deposit: '999'
    })
    expect(parsed.deposit).toBe('0')
  })

  it('carries no markup field a buyer could set', () => {
    // The installment charge is the developer's fee. This schema parses a form
    // the buyer controls, so it must not be a route by which the fee arrives:
    // a posted markupBps is dropped, not honoured. createSale resolves the
    // charge from the project instead, and only staff may override it.
    const parsed = PlanSelectionSchema.parse({
      unitId: 'u1',
      planType: 'INSTALLMENTS',
      deposit: '0',
      termMonths: '36',
      markupBps: '0',
      installmentMarkupBps: '0'
    })
    expect(parsed).not.toHaveProperty('markupBps')
    expect(parsed).not.toHaveProperty('installmentMarkupBps')
  })

  it('still rejects a genuinely invalid term', () => {
    expect(
      PlanSelectionSchema.safeParse({
        unitId: 'u1',
        planType: 'INSTALLMENTS',
        deposit: '0',
        termMonths: '0'
      }).success
    ).toBe(false)
  })
})
