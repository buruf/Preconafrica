import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthorizationError, type SessionActor } from '@/server/session'

/**
 * Who may read the log, and what they may see of it.
 *
 * The two properties here are the ones a leak would come from:
 *
 *   1. ADMIN only. The (staff) layout admits agents, so the page's own
 *      `requireAdmin` is not the only guard that matters — the service refuses
 *      an agent too, which is what keeps a future caller (a route handler, an
 *      export) from being the way round it.
 *   2. `orgId` is a predicate on every query, never a filter applied to the
 *      results. That distinction is the whole of tenant isolation: a filter
 *      after the fact still counts, paginates over and sorts another tenant's
 *      rows, and any one of those is a leak.
 */
vi.mock('@/server/db', () => ({
  prisma: {
    auditEntry: { count: vi.fn(), findMany: vi.fn() },
    user: { findMany: vi.fn() }
  }
}))

const { prisma } = await import('@/server/db')
const { listAuditEntries, AUDIT_PAGE_SIZE } = await import('@/server/services/audit')

const count = prisma.auditEntry.count as unknown as ReturnType<typeof vi.fn>
const findMany = prisma.auditEntry.findMany as unknown as ReturnType<typeof vi.fn>
const userFindMany = prisma.user.findMany as unknown as ReturnType<typeof vi.fn>

const admin: SessionActor = {
  userId: 'user_1',
  orgId: 'org_sunrise',
  role: 'ADMIN',
  buyerId: null,
  fullName: 'Ada Okafor',
  email: 'admin@sunrise.test'
}
const agent: SessionActor = { ...admin, userId: 'user_2', role: 'AGENT' }
const buyer: SessionActor = { ...admin, userId: 'user_3', role: 'BUYER', buyerId: 'buyer_1' }

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audit_1',
    actorName: 'Tunde Bakare',
    actorRole: 'AGENT',
    action: 'payment.recorded',
    entityType: 'Payment',
    entityId: 'payment_1',
    entityLabel: '4C',
    changes: [],
    context: { saleId: 'sale_1' },
    createdAt: new Date('2026-08-14T09:12:00.000Z'),
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  count.mockResolvedValue(1)
  findMany.mockResolvedValue([row()])
  userFindMany.mockResolvedValue([
    { id: 'user_1', fullName: 'Ada Okafor', role: 'ADMIN', disabledAt: null },
    { id: 'user_2', fullName: 'Tunde Bakare', role: 'AGENT', disabledAt: null }
  ])
})

describe('/audit authorization', () => {
  it('lets an admin read the log', async () => {
    await expect(listAuditEntries(admin, {})).resolves.toMatchObject({ total: 1 })
  })

  it('refuses an agent', async () => {
    await expect(listAuditEntries(agent, {})).rejects.toBeInstanceOf(AuthorizationError)
    // Refused before any query — the answer cannot be used to probe what exists.
    expect(count).not.toHaveBeenCalled()
    expect(findMany).not.toHaveBeenCalled()
  })

  it('refuses a buyer', async () => {
    await expect(listAuditEntries(buyer, {})).rejects.toBeInstanceOf(AuthorizationError)
    expect(findMany).not.toHaveBeenCalled()
  })
})

describe('/audit tenant scoping', () => {
  it('scopes the count, the page and the actor list to the actor’s organisation', async () => {
    await listAuditEntries(admin, {})

    // In the `where`, not applied to the results: a filter after the fact would
    // still have counted, ordered and paginated over another tenant's rows.
    expect(count.mock.calls[0][0].where).toMatchObject({ orgId: 'org_sunrise' })
    expect(findMany.mock.calls[0][0].where).toMatchObject({ orgId: 'org_sunrise' })
    expect(userFindMany.mock.calls[0][0].where).toMatchObject({ orgId: 'org_sunrise' })
  })

  it('keeps the organisation predicate whatever else is filtered', async () => {
    await listAuditEntries(admin, {
      entityType: 'Unit',
      actorUserId: 'user_2',
      from: '2026-08-01',
      to: '2026-08-31',
      page: 2
    })

    for (const call of [count.mock.calls[0][0], findMany.mock.calls[0][0]]) {
      expect(call.where.orgId).toBe('org_sunrise')
    }
  })

  it('cannot be pointed at another organisation by any search param', async () => {
    // There is deliberately no orgId input at all — the only organisation a
    // caller can name is the one their session is already inside.
    await listAuditEntries(admin, { entityType: 'Unit' } as never)
    expect(findMany.mock.calls[0][0].where.orgId).toBe('org_sunrise')
  })
})

describe('/audit filtering', () => {
  it('applies a known entity type and ignores an invented one', async () => {
    await listAuditEntries(admin, { entityType: 'Unit' })
    expect(findMany.mock.calls[0][0].where.entityType).toBe('Unit')

    vi.clearAllMocks()
    count.mockResolvedValue(0)
    findMany.mockResolvedValue([])
    userFindMany.mockResolvedValue([])

    const result = await listAuditEntries(admin, { entityType: "'; DROP TABLE" })
    // Dropped rather than passed through, and reported as dropped so the form
    // redraws blank instead of pretending a filter is active.
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('entityType')
    expect(result.applied.entityType).toBe('')
  })

  it('applies an actor who belongs to the organisation and ignores one who does not', async () => {
    await listAuditEntries(admin, { actorUserId: 'user_2' })
    expect(findMany.mock.calls[0][0].where.actorUserId).toBe('user_2')

    vi.clearAllMocks()
    count.mockResolvedValue(0)
    findMany.mockResolvedValue([])
    userFindMany.mockResolvedValue([
      { id: 'user_1', fullName: 'Ada Okafor', role: 'ADMIN', disabledAt: null }
    ])

    await listAuditEntries(admin, { actorUserId: 'user_from_another_org' })
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('actorUserId')
  })

  it('includes the whole of the day named as the upper bound', async () => {
    await listAuditEntries(admin, { from: '2026-08-01', to: '2026-08-14' })

    const createdAt = findMany.mock.calls[0][0].where.createdAt
    expect(createdAt.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z')
    // Not midnight at the start of the 14th, which would silently drop a whole
    // day of entries from a range whose upper bound the reader named.
    expect(createdAt.lte.toISOString()).toBe('2026-08-14T23:59:59.999Z')
  })

  it('ignores a date that is not a date', async () => {
    await listAuditEntries(admin, { from: 'yesterday', to: '' })
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('createdAt')
  })

  it('offers deactivated people in the actor filter', async () => {
    userFindMany.mockResolvedValue([
      { id: 'user_2', fullName: 'Tunde Bakare', role: 'AGENT', disabledAt: new Date() }
    ])

    const result = await listAuditEntries(admin, {})

    // A filter over the past has to include people who are no longer present —
    // they are precisely the ones somebody is looking for.
    expect(result.actors).toEqual([
      { id: 'user_2', fullName: 'Tunde Bakare', role: 'AGENT', active: false }
    ])
  })
})

describe('/audit paging', () => {
  it('reads the newest first, with a stable tiebreak', async () => {
    await listAuditEntries(admin, {})

    // `id` after `createdAt`: two entries written in one transaction can share
    // a millisecond, and without a second key one of them could repeat across
    // a page boundary while the other never appeared.
    expect(findMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  })

  it('skips a whole page at a time', async () => {
    count.mockResolvedValue(200)
    await listAuditEntries(admin, { page: 3 })

    expect(findMany.mock.calls[0][0].skip).toBe(2 * AUDIT_PAGE_SIZE)
    expect(findMany.mock.calls[0][0].take).toBe(AUDIT_PAGE_SIZE)
  })

  it('clamps a page number past the end onto the last page', async () => {
    count.mockResolvedValue(60) // three pages of 25

    const result = await listAuditEntries(admin, { page: 900 })

    // A stale link to page 40 of a filter that now has three pages should show
    // the last page, not an error.
    expect(result.page).toBe(3)
    expect(result.pageCount).toBe(3)
  })

  it('clamps a page number below one, and reports one page when empty', async () => {
    count.mockResolvedValue(0)
    findMany.mockResolvedValue([])

    const result = await listAuditEntries(admin, { page: -4 })

    expect(result.page).toBe(1)
    expect(result.pageCount).toBe(1)
    expect(result.entries).toEqual([])
  })
})

describe('/audit reads malformed rows without falling over', () => {
  it('degrades a changes column that is not an array to no changes', async () => {
    // The column is `Json`; nothing in the type system stops a hand-written row
    // or a newer schema version from holding a different shape. A page of
    // history must not 500 because of one row.
    findMany.mockResolvedValue([row({ changes: 'not an array', context: 'not an object' })])

    const result = await listAuditEntries(admin, {})

    expect(result.entries[0].changes).toEqual([])
    expect(result.entries[0].context).toEqual({})
  })

  it('drops a single malformed change and keeps the rest', async () => {
    findMany.mockResolvedValue([
      row({
        changes: [
          { field: 'priceMinor', from: { kind: 'none' }, to: { kind: 'number', value: 1 } },
          { nonsense: true }
        ]
      })
    ])

    const result = await listAuditEntries(admin, {})
    expect(result.entries[0].changes).toHaveLength(1)
  })
})
