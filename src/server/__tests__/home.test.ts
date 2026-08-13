import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArrearsRow } from '@/server/services/arrears'
import { AuthorizationError, type SessionActor } from '@/server/session'

/**
 * `staffHome` assembles the home screen out of figures other modules already
 * own, so there is exactly one thing in it worth a test: the derived count.
 *
 * `arrearsReport` returns **one row per overdue sale**, and `Buyer.sales` is a
 * list in the schema — one buyer can hold several contracts. Reading
 * `arrears.length` as a buyer count is therefore wrong whenever any buyer is
 * late on two units, and wrong in the direction that overstates the problem
 * under a label that says "Buyers overdue". It is also the exact reason
 * `ArrearsRow` carries `buyerId` at all.
 *
 * The failure it produced was worse than a wrong number in isolation: `/arrears`
 * already counted distinct buyers, so the same organisation could read 3 on the
 * home screen and 2 on the arrears report, under the identical label, in the same
 * session. The last test below pins the two together.
 */
vi.mock('@/server/db', () => ({
  prisma: {
    project: { findMany: vi.fn() },
    unit: { groupBy: vi.fn() },
    sale: { count: vi.fn() }
  }
}))

vi.mock('@/server/services/team', () => ({
  getOrganizationName: vi.fn(async () => 'Sunrise Developments')
}))

vi.mock('@/server/services/arrears', () => ({
  arrearsReport: vi.fn()
}))

const { prisma } = await import('@/server/db')
const { arrearsReport } = await import('@/server/services/arrears')
const { staffHome } = await import('@/server/services/home')

const findMany = prisma.project.findMany as unknown as ReturnType<typeof vi.fn>
const groupBy = prisma.unit.groupBy as unknown as ReturnType<typeof vi.fn>
const saleCount = prisma.sale.count as unknown as ReturnType<typeof vi.fn>
const report = arrearsReport as unknown as ReturnType<typeof vi.fn>

const actor: SessionActor = {
  userId: 'user_1',
  orgId: 'org_1',
  role: 'ADMIN',
  buyerId: null,
  fullName: 'Tunde Bakare',
  email: 'admin@sunrise.test'
}

const AS_OF = new Date('2026-08-12T00:00:00Z')

/**
 * An overdue row. `saleId` and `buyerId` are separate arguments on purpose —
 * every test here is about the case where they do not correspond one to one.
 */
const overdue = (saleId: string, buyerId: string): ArrearsRow => ({
  saleId,
  buyerId,
  buyerName: `Buyer ${buyerId}`,
  buyerPhone: '+2348031234567',
  buyerEmail: `${buyerId}@buyer.test`,
  projectId: 'project_1',
  projectName: 'Sunrise Heights',
  unitName: saleId,
  currency: 'NGN',
  overdueCount: 1,
  overdueAmountMinor: 93_611_111n,
  oldestDueDate: new Date('2026-05-01T00:00:00Z'),
  daysLate: 103
})

beforeEach(() => {
  findMany.mockReset()
  groupBy.mockReset()
  saleCount.mockReset()
  report.mockReset()

  findMany.mockResolvedValue([])
  groupBy.mockResolvedValue([])
  saleCount.mockResolvedValue(0)
  report.mockResolvedValue([])
})

describe('staffHome — buyers overdue', () => {
  it('counts one buyer once when they are late on two contracts', async () => {
    // The regression. Two rows, one person: one phone call to make, not two.
    report.mockResolvedValue([overdue('sale_a', 'buyer_1'), overdue('sale_b', 'buyer_1')])

    const home = await staffHome(actor, AS_OF)

    expect(home.buyersOverdue).toBe(1)
    // Stated explicitly, because 2 is the row count and the number the old
    // implementation returned.
    expect(home.buyersOverdue).not.toBe(2)
  })

  it('counts two buyers as two when the contracts belong to different people', async () => {
    const home = await staffHome(actor, AS_OF)
    expect(home.buyersOverdue).toBe(0)

    report.mockResolvedValue([overdue('sale_a', 'buyer_1'), overdue('sale_b', 'buyer_2')])
    expect((await staffHome(actor, AS_OF)).buyersOverdue).toBe(2)
  })

  it('agrees with the arrears page, which counts the same rows the same way', async () => {
    // Five contracts, three buyers. `/arrears` computes
    // `new Set(rows.map((r) => r.buyerId)).size` and prints "across 5 contracts";
    // the home screen must reach the same 3 from the same rows, or one label
    // means two things.
    const rows = [
      overdue('sale_a', 'buyer_1'),
      overdue('sale_b', 'buyer_1'),
      overdue('sale_c', 'buyer_2'),
      overdue('sale_d', 'buyer_3'),
      overdue('sale_e', 'buyer_3')
    ]
    report.mockResolvedValue(rows)

    const home = await staffHome(actor, AS_OF)
    expect(home.buyersOverdue).toBe(new Set(rows.map((row) => row.buyerId)).size)
    expect(home.buyersOverdue).toBe(3)
    expect(rows).toHaveLength(5)
  })
})

describe('staffHome authorization', () => {
  // assertRole runs before the first read, so these reject without a database.
  // The home screen carries every project's inventory and the arrears head count.
  it('refuses a BUYER', async () => {
    await expect(staffHome({ ...actor, role: 'BUYER' }, AS_OF)).rejects.toBeInstanceOf(
      AuthorizationError
    )
  })

  it('refuses a role outside the enum', async () => {
    await expect(
      staffHome({ ...actor, role: 'SUPERUSER' as SessionActor['role'] }, AS_OF)
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})
