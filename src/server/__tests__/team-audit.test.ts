import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceError } from '@/server/services/errors'
import type { SessionActor } from '@/server/session'
import { auditRecorder } from './audit-fake'

/**
 * Access changes, end to end: adding an agent, taking one away, and setting the
 * organisation's letterhead.
 *
 * These are the third of the three things the log covers — money, inventory,
 * access — and the one with no financial trail of its own to fall back on. A
 * `User` row that was created and then deactivated leaves `createdAt` and
 * `disabledAt` and no answer at all to "who let them in".
 */
vi.mock('@/server/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    organization: { findUnique: vi.fn() },
    $transaction: vi.fn()
  }
}))
vi.mock('@/server/media/blob', () => ({ deleteReplacedBlobs: vi.fn(async () => undefined) }))

const { prisma } = await import('@/server/db')
const { createAgent, deactivateAgent, updateOrganizationLogo } = await import(
  '@/server/services/team'
)

const userFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const userFindFirst = prisma.user.findFirst as unknown as ReturnType<typeof vi.fn>
const orgFindUnique = prisma.organization.findUnique as unknown as ReturnType<typeof vi.fn>
const $transaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>

const admin: SessionActor = {
  userId: 'user_1',
  orgId: 'org_1',
  role: 'ADMIN',
  buyerId: null,
  fullName: 'Ada Okafor',
  email: 'admin@sunrise.test'
}

let audit = auditRecorder()
let calls: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  calls = []
  audit = auditRecorder((action) => calls.push(`audit:${action}`))
  userFindUnique.mockResolvedValue(null)
  $transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      user: {
        create: async ({ data }: { data: { fullName: string } }) => {
          calls.push('user.create')
          return { id: 'user_new', ...data }
        },
        update: async () => {
          calls.push('user.update')
          return {}
        }
      },
      organization: {
        update: async () => {
          calls.push('organization.update')
          return {}
        }
      },
      auditEntry: audit.auditEntry
    })
  )
})

describe('adding an agent is recorded', () => {
  it('records who added whom, in the same transaction as the account', async () => {
    await createAgent(admin, {
      fullName: 'Chidi Okeke',
      email: 'chidi@sunrise.test',
      password: 'password123'
    })

    const [entry] = audit.of('user.agent_added')
    expect(entry).toBeDefined()
    expect(entry.actorUserId).toBe('user_1')
    expect(entry.actorName).toBe('Ada Okafor')
    expect(entry.entityType).toBe('User')
    expect(entry.entityId).toBe('user_new')
    expect(entry.entityLabel).toBe('Chidi Okeke')
    // Granting access with no record of who granted it is exactly the gap this
    // closes, so the two must commit together.
    expect(calls).toEqual(['user.create', 'audit:user.agent_added'])
  })

  it('records no password, hashed or otherwise', async () => {
    await createAgent(admin, {
      fullName: 'Chidi Okeke',
      email: 'chidi@sunrise.test',
      password: 'password123'
    })

    const serialised = JSON.stringify(audit.entries)
    expect(serialised).not.toContain('password123')
    expect(serialised).not.toContain('$2a$')
    expect(serialised).not.toContain('passwordHash')
  })

  it('records nothing when the email was already taken', async () => {
    userFindUnique.mockResolvedValue({ id: 'user_existing' })

    await expect(
      createAgent(admin, {
        fullName: 'Chidi Okeke',
        email: 'chidi@sunrise.test',
        password: 'password123'
      })
    ).rejects.toBeInstanceOf(ServiceError)

    expect(audit.entries).toHaveLength(0)
    expect($transaction).not.toHaveBeenCalled()
  })
})

describe('deactivating an agent is recorded', () => {
  it('records who revoked whose access', async () => {
    userFindFirst.mockResolvedValue({ id: 'user_2', fullName: 'Chidi Okeke', role: 'AGENT' })

    await deactivateAgent(admin, 'user_2')

    const [entry] = audit.of('user.agent_deactivated')
    expect(entry).toBeDefined()
    expect(entry.actorName).toBe('Ada Okafor')
    expect(entry.entityId).toBe('user_2')
    expect(entry.entityLabel).toBe('Chidi Okeke')
    expect(entry.changes).toEqual([
      {
        field: 'status',
        from: { kind: 'enum', value: 'ACTIVE' },
        to: { kind: 'enum', value: 'DEACTIVATED' }
      }
    ])
    expect(calls).toEqual(['user.update', 'audit:user.agent_deactivated'])
  })

  it('records nothing when the agent was not found', async () => {
    userFindFirst.mockResolvedValue(null)

    await expect(deactivateAgent(admin, 'user_from_another_org')).rejects.toBeInstanceOf(
      ServiceError
    )
    expect(audit.entries).toHaveLength(0)
  })

  it('records nothing when an admin tries to remove themselves', async () => {
    await expect(deactivateAgent(admin, 'user_1')).rejects.toBeInstanceOf(ServiceError)
    expect(audit.entries).toHaveLength(0)
  })
})

describe('changing the organisation letterhead is recorded', () => {
  it('records the change without printing the URL in the sentence', async () => {
    orgFindUnique.mockResolvedValue({ logoUrl: null })

    await updateOrganizationLogo(admin, { logoUrl: 'https://cdn.test/logo.png' })

    const [entry] = audit.of('org.updated')
    expect(entry).toBeDefined()
    expect(entry.entityType).toBe('Organization')
    expect(entry.entityId).toBe('org_1')
    expect(entry.changes).toEqual([
      {
        field: 'logoUrl',
        from: { kind: 'none' },
        to: { kind: 'image', url: 'https://cdn.test/logo.png' }
      }
    ])
  })

  it('records nothing when the same logo is saved again', async () => {
    orgFindUnique.mockResolvedValue({ logoUrl: 'https://cdn.test/logo.png' })

    await updateOrganizationLogo(admin, { logoUrl: 'https://cdn.test/logo.png' })

    expect(audit.entries).toHaveLength(0)
    // The write still happened; only the non-event went unrecorded.
    expect(calls).toEqual(['organization.update'])
  })
})
