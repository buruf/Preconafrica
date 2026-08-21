import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Deleting a developer, which is allowed only when there is nothing to lose.
 *
 * This exists for one situation and no other: a mistyped developer, created a
 * minute ago, with no projects, no buyers and no sales. That is an ordinary
 * thing to need, and before this the answer was "live with it" — the short name
 * is fixed at creation, so a typo was permanent.
 *
 * Every test below is about the refusal rather than the deletion. A developer
 * with real data is suspended, never deleted: `Organization.users` cascades, so
 * a delete that slipped through would take staff accounts with it, and a system
 * of record that can be made to forget a sale is not one.
 */

const auditCalls: Array<Record<string, unknown>> = []

vi.mock('@/server/audit/platform-record', () => ({
  recordPlatformAudit: vi.fn(async (_tx: unknown, _a: unknown, input: Record<string, unknown>) => {
    auditCalls.push(input)
  })
}))

const orgDelete = vi.fn(async () => ({ id: 'org_1' }))
const orgFindUnique = vi.fn()

vi.mock('@/server/db', () => ({
  prisma: {
    organization: { findUnique: orgFindUnique, delete: orgDelete },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ organization: { delete: orgDelete } })
    )
  }
}))

const { prisma } = await import('@/server/db')
const { deleteDeveloper } = await import('@/server/services/platform')

const ACTOR = { kind: 'platform', userId: 'p1', fullName: 'Operator', email: 'o@x.test' } as never

const EMPTY = {
  id: 'org_1',
  name: 'Khaleel Developmnet',
  _count: { projects: 0, buyers: 0, sales: 0, payments: 0, documents: 0 }
}

beforeEach(() => {
  auditCalls.length = 0
  orgDelete.mockClear()
  vi.mocked(prisma.organization.findUnique).mockResolvedValue(EMPTY as never)
})

describe('deleteDeveloper', () => {
  it('deletes one with nothing in it', async () => {
    await deleteDeveloper(ACTOR, 'org_1')
    expect(orgDelete).toHaveBeenCalledOnce()
  })

  it('records the deletion, naming what is gone', async () => {
    // The organisation will not exist to join to afterwards, so the name has to
    // be captured in the entry itself.
    await deleteDeveloper(ACTOR, 'org_1')
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]).toMatchObject({
      action: 'developer.deleted',
      entityType: 'Organization',
      entityLabel: 'Khaleel Developmnet'
    })
  })

  it('refuses one that has a project', async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      ...EMPTY,
      _count: { ...EMPTY._count, projects: 1 }
    } as never)
    await expect(deleteDeveloper(ACTOR, 'org_1')).rejects.toThrow('not empty')
    expect(orgDelete).not.toHaveBeenCalled()
  })

  it('refuses one that has a buyer', async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      ...EMPTY,
      _count: { ...EMPTY._count, buyers: 1 }
    } as never)
    await expect(deleteDeveloper(ACTOR, 'org_1')).rejects.toThrow('not empty')
    expect(orgDelete).not.toHaveBeenCalled()
  })

  it('refuses one that has a sale', async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      ...EMPTY,
      _count: { ...EMPTY._count, sales: 1 }
    } as never)
    await expect(deleteDeveloper(ACTOR, 'org_1')).rejects.toThrow('not empty')
    expect(orgDelete).not.toHaveBeenCalled()
  })

  it('refuses one that has a payment, even with no sale left', async () => {
    // Payments and documents are counted in their own right rather than
    // inferred from sales. A sale is Restrict-protected so it cannot vanish
    // beneath its payments — but this check must not depend on that being
    // true forever, because being wrong here destroys money history.
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      ...EMPTY,
      _count: { ...EMPTY._count, payments: 1 }
    } as never)
    await expect(deleteDeveloper(ACTOR, 'org_1')).rejects.toThrow('not empty')
    expect(orgDelete).not.toHaveBeenCalled()
  })

  it('refuses one that has an issued document', async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      ...EMPTY,
      _count: { ...EMPTY._count, documents: 1 }
    } as never)
    await expect(deleteDeveloper(ACTOR, 'org_1')).rejects.toThrow('not empty')
    expect(orgDelete).not.toHaveBeenCalled()
  })

  it('refuses one that does not exist', async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(null as never)
    await expect(deleteDeveloper(ACTOR, 'org_1')).rejects.toThrow('not found')
    expect(orgDelete).not.toHaveBeenCalled()
  })
})
