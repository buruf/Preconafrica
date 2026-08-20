import { beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'

/**
 * A platform operator changing their own password.
 *
 * The same rules the developer-facing `changePassword` holds to, because the
 * account they protect is strictly more powerful: the current password must be
 * proved, the new one must differ, and `passwordChangedAt` must be stamped so
 * every session opened with the old password dies on its next request.
 *
 * That last one is the point of the whole flow here. The first password is a
 * generated temporary shown once on a terminal, so the moment it is replaced,
 * anything opened with it must stop working.
 */

type Args = { data: Record<string, unknown> }

const platformUpdate = vi.fn(async (_args: Args) => ({ id: 'p1', fullName: 'Operator' }))
const platformFindUnique = vi.fn()
const auditCalls: Array<Record<string, unknown>> = []

vi.mock('@/server/audit/platform-record', () => ({
  recordPlatformAudit: vi.fn(async (_tx: unknown, _a: unknown, input: Record<string, unknown>) => {
    auditCalls.push(input)
  })
}))

vi.mock('@/server/db', () => ({
  prisma: {
    platformUser: { update: platformUpdate, findUnique: platformFindUnique },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ platformUser: { update: platformUpdate } })
    )
  }
}))

const { changePlatformPassword } = await import('@/server/services/platform')

const NOW = new Date('2026-08-20T10:00:00Z')
const CURRENT = 'the-temporary-one-from-the-terminal'
const ACTOR = { kind: 'platform', userId: 'p1', fullName: 'Operator', email: 'ops@x.test' } as never

beforeEach(async () => {
  auditCalls.length = 0
  platformUpdate.mockClear()
  platformFindUnique.mockResolvedValue({
    passwordHash: await bcrypt.hash(CURRENT, 4),
    disabledAt: null,
    fullName: 'Operator'
  } as never)
})

describe('changePlatformPassword', () => {
  it('stamps passwordChangedAt, which is what revokes the old sessions', async () => {
    await changePlatformPassword(ACTOR, CURRENT, 'a-brand-new-strong-one', NOW)

    expect(platformUpdate).toHaveBeenCalledOnce()
    expect(platformUpdate.mock.calls[0][0].data.passwordChangedAt).toEqual(NOW)
  })

  it('stores a hash, never the password', async () => {
    await changePlatformPassword(ACTOR, CURRENT, 'a-brand-new-strong-one', NOW)
    const stored = platformUpdate.mock.calls[0][0].data.passwordHash as string

    expect(stored).toMatch(/^\$2[aby]\$/)
    expect(stored).not.toContain('a-brand-new-strong-one')
  })

  it('refuses when the current password is wrong', async () => {
    await expect(
      changePlatformPassword(ACTOR, 'not-the-current-one', 'a-brand-new-strong-one', NOW)
    ).rejects.toThrow('current password is incorrect')
    expect(platformUpdate).not.toHaveBeenCalled()
  })

  it('refuses a new password identical to the old', async () => {
    // Otherwise it reports success while revoking every session — the worst
    // possible answer to "did anything happen?".
    await expect(changePlatformPassword(ACTOR, CURRENT, CURRENT, NOW)).rejects.toThrow('different')
    expect(platformUpdate).not.toHaveBeenCalled()
  })

  it('refuses a short new password', async () => {
    await expect(changePlatformPassword(ACTOR, CURRENT, 'short', NOW)).rejects.toThrow()
    expect(platformUpdate).not.toHaveBeenCalled()
  })

  it('refuses a deactivated operator', async () => {
    platformFindUnique.mockResolvedValue({
      passwordHash: await bcrypt.hash(CURRENT, 4),
      disabledAt: NOW,
      fullName: 'Operator'
    } as never)
    await expect(
      changePlatformPassword(ACTOR, CURRENT, 'a-brand-new-strong-one', NOW)
    ).rejects.toThrow()
    expect(platformUpdate).not.toHaveBeenCalled()
  })

  it('records the change without recording either password', async () => {
    await changePlatformPassword(ACTOR, CURRENT, 'a-brand-new-strong-one', NOW)

    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]).toMatchObject({ action: 'operator.password_changed' })
    expect(JSON.stringify(auditCalls[0])).not.toContain('a-brand-new-strong-one')
    expect(JSON.stringify(auditCalls[0])).not.toContain(CURRENT)
  })
})
