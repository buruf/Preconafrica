import { beforeEach, describe, expect, it, vi } from 'vitest'

const auditCalls: Array<Record<string, unknown>> = []

vi.mock('@/server/audit/platform-record', () => ({
  recordPlatformAudit: vi.fn(async (_tx: unknown, _actor: unknown, input: Record<string, unknown>) => {
    auditCalls.push(input)
  })
}))

type Args = { data: Record<string, unknown> }

const orgCreate = vi.fn(async (_args: Args) => ({ id: 'org_new', name: 'Khaleel Homes', slug: 'khaleel' }))
const userCreate = vi.fn(async (_args: Args) => ({ id: 'u_new', email: 'admin@khaleel.test' }))
const orgUpdate = vi.fn(async (_args: Args) => ({ id: 'org_1', name: 'Sunrise', suspendedAt: new Date() }))
const orgFindFirst = vi.fn()
const userFindUnique = vi.fn()

vi.mock('@/server/db', () => ({
  prisma: {
    organization: { create: orgCreate, update: orgUpdate, findFirst: orgFindFirst, findUnique: vi.fn() },
    user: { create: userCreate, findUnique: userFindUnique },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        organization: { create: orgCreate, update: orgUpdate },
        user: { create: userCreate }
      })
    )
  }
}))

const { createDeveloper, setDeveloperSuspended } = await import('@/server/services/platform')

const PLATFORM = { kind: 'platform', userId: 'p1', fullName: 'Operator', email: 'ops@precon.test' } as never

const VALID = {
  name: 'Khaleel Homes',
  slug: 'khaleel',
  adminFullName: 'Khaleel Farah',
  adminEmail: 'admin@khaleel.test'
}

beforeEach(() => {
  auditCalls.length = 0
  orgCreate.mockClear()
  userCreate.mockClear()
  orgUpdate.mockClear()
  orgFindFirst.mockResolvedValue(null as never)
  userFindUnique.mockResolvedValue(null as never)
})

describe('createDeveloper', () => {
  it('creates the organisation and its first admin together', async () => {
    const result = await createDeveloper(PLATFORM, VALID)

    expect(result.orgId).toBe('org_new')
    expect(orgCreate).toHaveBeenCalledOnce()
    expect(userCreate).toHaveBeenCalledOnce()
    // The role is not a parameter: the first account for a new developer is
    // always their ADMIN, or nobody can administer the organisation.
    expect(userCreate.mock.calls[0][0].data.role).toBe('ADMIN')
  })

  it('never stores the temporary password in plain text', async () => {
    const result = await createDeveloper(PLATFORM, VALID)
    const stored = userCreate.mock.calls[0][0].data.passwordHash

    expect(stored).toMatch(/^\$2[aby]\$/)
    expect(stored).not.toBe(result.temporaryPassword)
    expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(16)
  })

  it('refuses a slug that is already taken', async () => {
    orgFindFirst.mockResolvedValue({ id: 'org_1' } as never)
    await expect(createDeveloper(PLATFORM, VALID)).rejects.toThrow('already')
    expect(orgCreate).not.toHaveBeenCalled()
  })

  it('refuses an email that already belongs to someone', async () => {
    // User.email is globally unique across every organisation, so this would
    // fail at the database anyway — caught here to say why.
    userFindUnique.mockResolvedValue({ id: 'u_existing' } as never)
    await expect(createDeveloper(PLATFORM, VALID)).rejects.toThrow('already')
    expect(orgCreate).not.toHaveBeenCalled()
  })

  it('lowercases the admin email, as the sign-in lookup does', async () => {
    await createDeveloper(PLATFORM, { ...VALID, adminEmail: 'Admin@Khaleel.TEST' })
    expect(userCreate.mock.calls[0][0].data.email).toBe('admin@khaleel.test')
  })

  it('records one platform audit entry naming the developer', async () => {
    await createDeveloper(PLATFORM, VALID)
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]).toMatchObject({
      action: 'developer.created',
      entityType: 'Organization',
      entityLabel: 'Khaleel Homes'
    })
  })

  it('rejects a slug that is not url-safe', async () => {
    await expect(createDeveloper(PLATFORM, { ...VALID, slug: 'Khaleel Homes!' })).rejects.toThrow()
    expect(orgCreate).not.toHaveBeenCalled()
  })
})

describe('setDeveloperSuspended', () => {
  it('suspends, and says so in the log', async () => {
    await setDeveloperSuspended(PLATFORM, 'org_1', true)
    expect(orgUpdate).toHaveBeenCalledOnce()
    expect(orgUpdate.mock.calls[0][0].data.suspendedAt).toBeInstanceOf(Date)
    expect(auditCalls[0]).toMatchObject({ action: 'developer.suspended' })
  })

  it('lifts a suspension, and says that instead', async () => {
    await setDeveloperSuspended(PLATFORM, 'org_1', false)
    expect(orgUpdate.mock.calls[0][0].data.suspendedAt).toBeNull()
    expect(auditCalls[0]).toMatchObject({ action: 'developer.unsuspended' })
  })
})
