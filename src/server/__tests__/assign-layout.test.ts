import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Assigning one drawing to many units. Everything worth asserting here is a
 * refusal or an attribution — the update itself is one `updateMany`.
 *
 * `@/server/db` is mocked, as in every other service test: these are questions
 * about which branch was taken, not about Postgres.
 */

const auditCalls: Array<Record<string, unknown>> = []

vi.mock('@/server/audit/record', () => ({
  recordAudit: vi.fn(async (_tx: unknown, _actor: unknown, input: Record<string, unknown>) => {
    auditCalls.push(input)
  })
}))

const updateMany = vi.fn(async () => ({ count: 2 }))

vi.mock('@/server/db', () => ({
  prisma: {
    project: { findFirst: vi.fn() },
    unit: { findMany: vi.fn(), updateMany },
    // The interactive transaction hands the callback a client that writes the
    // same way the real one does, so "the audit ran inside the transaction" is
    // observable rather than assumed.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ unit: { updateMany } })
    )
  }
}))

const { prisma } = await import('@/server/db')
const { assignLayoutToUnits } = await import('@/server/services/units')

const ADMIN = { userId: 'u1', orgId: 'org_sunrise', role: 'ADMIN', fullName: 'Adaeze Okonkwo' } as never
const AGENT = { userId: 'u2', orgId: 'org_sunrise', role: 'AGENT', fullName: 'Tunde Bakare' } as never

const OURS =
  'https://x.public.blob.vercel-storage.com/org/org_sunrise/unit/u1/layout-abc.png'

beforeEach(() => {
  auditCalls.length = 0
  vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p1', name: 'Khaleel Suites' } as never)
  vi.mocked(prisma.unit.findMany).mockResolvedValue([{ id: 'a' }, { id: 'b' }] as never)
  updateMany.mockClear()
})

describe('assignLayoutToUnits', () => {
  it('writes the same drawing to every chosen unit', async () => {
    const result = await assignLayoutToUnits(ADMIN, {
      projectId: 'p1',
      imageUrl: OURS,
      unitIds: ['a', 'b']
    })

    expect(result).toEqual({ assigned: 2 })
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] } },
      data: { layoutImageUrl: OURS }
    })
  })

  it('refuses an agent', async () => {
    await expect(
      assignLayoutToUnits(AGENT, { projectId: 'p1', imageUrl: OURS, unitIds: ['a'] })
    ).rejects.toThrow()
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('refuses a project in another organisation', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null as never)
    await expect(
      assignLayoutToUnits(ADMIN, { projectId: 'p1', imageUrl: OURS, unitIds: ['a'] })
    ).rejects.toThrow('Project not found')
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('refuses a unit that is not in this project', async () => {
    // Two ids asked for, one came back scoped — the missing one belongs
    // somewhere else, and a partial write would be worse than none.
    vi.mocked(prisma.unit.findMany).mockResolvedValue([{ id: 'a' }] as never)
    await expect(
      assignLayoutToUnits(ADMIN, { projectId: 'p1', imageUrl: OURS, unitIds: ['a', 'b'] })
    ).rejects.toThrow('not in this project')
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('refuses an image this organisation did not upload', async () => {
    await expect(
      assignLayoutToUnits(ADMIN, {
        projectId: 'p1',
        imageUrl: 'https://partner.example/tower.png',
        unitIds: ['a']
      })
    ).rejects.toThrow('not one this organisation uploaded')
    expect(updateMany).not.toHaveBeenCalled()
  })

  it("refuses another tenant's blob", async () => {
    await expect(
      assignLayoutToUnits(ADMIN, {
        projectId: 'p1',
        imageUrl:
          'https://x.public.blob.vercel-storage.com/org/org_other/unit/z/layout-abc.png',
        unitIds: ['a']
      })
    ).rejects.toThrow('not one this organisation uploaded')
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('records one entry for the batch, not one per unit', async () => {
    await assignLayoutToUnits(ADMIN, { projectId: 'p1', imageUrl: OURS, unitIds: ['a', 'b'] })

    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]).toMatchObject({
      action: 'unit.layout_assigned',
      entityType: 'Project',
      entityLabel: 'Khaleel Suites',
      context: { projectId: 'p1', projectName: 'Khaleel Suites', unitCount: 2 }
    })
  })

  it('refuses an empty selection', async () => {
    await expect(
      assignLayoutToUnits(ADMIN, { projectId: 'p1', imageUrl: OURS, unitIds: [] })
    ).rejects.toThrow()
    expect(updateMany).not.toHaveBeenCalled()
  })
})
