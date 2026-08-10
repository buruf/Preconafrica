import { describe, expect, it } from 'vitest'
import { arrearsReport, buildArrearsRows } from '@/server/services/arrears'
import { AuthorizationError, type SessionActor } from '@/server/session'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

const sale = (id: string, entries: Array<[Date, bigint, bigint]>) => ({
  id,
  currency: 'KES',
  buyer: { fullName: `Buyer ${id}`, phone: '+254712345678', email: `${id}@example.com` },
  project: { name: 'Riverside Court' },
  unit: { name: '4C' },
  scheduleEntries: entries.map(([dueDate, amountDueMinor, amountPaidMinor]) => ({
    dueDate,
    amountDueMinor,
    amountPaidMinor
  }))
})

describe('buildArrearsRows', () => {
  const asOf = utc(2026, 8, 9)

  it('lists a buyer with overdue entries', () => {
    const rows = buildArrearsRows(
      [sale('a', [[utc(2026, 6, 10), 300n, 0n], [utc(2026, 7, 10), 300n, 100n]])],
      asOf
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].overdueCount).toBe(2)
    expect(rows[0].overdueAmountMinor).toBe(500n)
    expect(rows[0].daysLate).toBe(60)
    expect(rows[0].oldestDueDate.toISOString().slice(0, 10)).toBe('2026-06-10')
  })

  it('excludes buyers with nothing overdue', () => {
    expect(
      buildArrearsRows([sale('b', [[utc(2026, 9, 10), 300n, 0n]])], asOf)
    ).toEqual([])
  })

  it('excludes fully paid past entries', () => {
    expect(
      buildArrearsRows([sale('c', [[utc(2026, 6, 10), 300n, 300n]])], asOf)
    ).toEqual([])
  })

  it('does not count an entry due today as overdue', () => {
    expect(buildArrearsRows([sale('d', [[asOf, 300n, 0n]])], asOf)).toEqual([])
  })

  it('sorts the most delinquent buyer first', () => {
    const rows = buildArrearsRows(
      [
        sale('recent', [[utc(2026, 7, 10), 300n, 0n]]),
        sale('oldest', [[utc(2026, 2, 10), 300n, 0n]]),
        sale('middle', [[utc(2026, 5, 10), 300n, 0n]])
      ],
      asOf
    )
    expect(rows.map((r) => r.saleId)).toEqual(['oldest', 'middle', 'recent'])
  })

  it('carries contact details for follow-up', () => {
    const rows = buildArrearsRows([sale('e', [[utc(2026, 6, 10), 300n, 0n]])], asOf)
    expect(rows[0].buyerPhone).toBe('+254712345678')
    expect(rows[0].currency).toBe('KES')
    expect(rows[0].unitName).toBe('4C')
  })
})

describe('arrearsReport authorization', () => {
  const actor = (role: string): SessionActor => ({
    userId: 'u1',
    orgId: 'o1',
    role: role as SessionActor['role'],
    buyerId: null,
    fullName: 'Test User',
    email: 'test@example.com'
  })

  // assertRole runs before the first Prisma call, so these reject without a
  // database. Arrears carries every buyer's phone and outstanding balance —
  // it must never be reachable by a buyer or an unrecognised role.
  it('refuses a BUYER', async () => {
    await expect(arrearsReport(actor('BUYER'), new Date())).rejects.toBeInstanceOf(
      AuthorizationError
    )
  })

  it('refuses a role outside the enum', async () => {
    await expect(arrearsReport(actor('SUPERUSER'), new Date())).rejects.toBeInstanceOf(
      AuthorizationError
    )
  })
})
