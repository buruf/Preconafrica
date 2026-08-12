import bcrypt from 'bcryptjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashResetToken } from '@/domain/password-reset'

/**
 * The password service's job is almost entirely *refusal*, and every refusal is
 * a database outcome: no such user, deactivated user, token already spent,
 * token expired, another request seconds ago. So `@/server/db` is mocked (this
 * file talks to no Postgres) and the assertions are about which branch was
 * taken and what the caller was — and was not — told.
 *
 * Two properties are worth more here than any individual case:
 *   1. requestPasswordReset never throws and never distinguishes a missing
 *      account from a real one. A test that only checks "returns a URL for a
 *      real user" would pass while the missing-user path threw a 500 that
 *      enumerated the user table.
 *   2. resetPassword returns one byte-identical message for four different
 *      failures. Asserting the four are *equal to each other* catches the
 *      well-meaning future edit that makes one of them more helpful.
 *
 * The fake `tx` follows allocations.test.ts: it records every statement, so
 * the tests can also pin down that the writes happen together and that no raw
 * token is ever handed to the database.
 */

interface RecordedCall {
  op: string
  args: unknown
}

const calls: RecordedCall[] = []

function record<T>(op: string, result: T) {
  return async (args: unknown) => {
    calls.push({ op, args })
    return result
  }
}

/** Mutable per-test fixtures the mocked client reads from. */
const state = {
  user: null as { id: string; fullName: string; disabledAt: Date | null } | null,
  /** The row `user.findUnique` returns for changePassword's id lookup. */
  userForChange: null as { passwordHash: string; disabledAt: Date | null } | null,
  recentToken: null as { id: string } | null,
  token: null as {
    id: string
    userId: string
    expiresAt: Date
    usedAt: Date | null
    user: { disabledAt: Date | null }
  } | null,
  /** What the conditional claim-the-token update reports having matched. */
  claimedCount: 1
}

vi.mock('@/server/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async (args: { select?: Record<string, boolean> }) => {
        calls.push({ op: 'user.findUnique', args })
        // changePassword selects the hash; requestPasswordReset does not.
        return args.select?.passwordHash ? state.userForChange : state.user
      })
    },
    passwordResetToken: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ op: 'passwordResetToken.findFirst', args })
        return state.recentToken
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ op: 'passwordResetToken.findUnique', args })
        return state.token
      })
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      calls.push({ op: '$transaction', args: null })
      const tx = {
        passwordResetToken: {
          updateMany: async (args: { where: { id?: string } }) => {
            calls.push({ op: 'tx.passwordResetToken.updateMany', args })
            // Only the conditional claim (which filters by a specific id) is
            // allowed to report zero; the sweep of the rest is unconditional.
            return { count: args.where.id ? state.claimedCount : 0 }
          },
          create: record('tx.passwordResetToken.create', { id: 'tok_new' })
        },
        user: { update: record('tx.user.update', {}) }
      }
      return fn(tx)
    })
  }
}))

const { prisma } = await import('@/server/db')
const { requestPasswordReset, resetPassword, changePassword } = await import(
  '@/server/services/passwords'
)
const { ServiceError } = await import('@/server/services/errors')

const NOW = new Date('2026-08-11T12:00:00.000Z')
const ACTIVE_USER = { id: 'usr_1', fullName: 'Chidi Okeke', disabledAt: null }

function callsOf(op: string): RecordedCall[] {
  return calls.filter((c) => c.op === op)
}

beforeEach(() => {
  calls.length = 0
  state.user = null
  state.userForChange = null
  state.recentToken = null
  state.token = null
  state.claimedCount = 1
  vi.mocked(prisma.user.findUnique).mockClear()
  process.env.NEXTAUTH_URL = 'https://precon.test'
})

describe('requestPasswordReset', () => {
  it('issues a link for an active user', async () => {
    state.user = ACTIVE_USER

    const result = await requestPasswordReset('chidi@sunrise.test', NOW)

    expect(result.resetUrl).toMatch(/^https:\/\/precon\.test\/reset-password\?token=.+/)
    expect(result.fullName).toBe('Chidi Okeke')
    expect(callsOf('tx.passwordResetToken.create')).toHaveLength(1)
  })

  it('stores only the hash of the token, never the raw value', async () => {
    state.user = ACTIVE_USER

    const { resetUrl } = await requestPasswordReset('chidi@sunrise.test', NOW)
    const rawToken = new URL(resetUrl as string).searchParams.get('token') as string

    const created = callsOf('tx.passwordResetToken.create')[0].args as {
      data: { tokenHash: string; expiresAt: Date }
    }
    expect(created.data.tokenHash).toBe(hashResetToken(rawToken))
    expect(created.data.tokenHash).not.toBe(rawToken)
    // Nothing anywhere in the statements sent to the database contains the raw
    // token — this is the assertion that would fail if someone added a
    // "for debugging" column later.
    expect(JSON.stringify(calls)).not.toContain(rawToken)
  })

  it('expires the token one hour out', async () => {
    state.user = ACTIVE_USER

    await requestPasswordReset('chidi@sunrise.test', NOW)

    const created = callsOf('tx.passwordResetToken.create')[0].args as {
      data: { expiresAt: Date }
    }
    expect(created.data.expiresAt.getTime() - NOW.getTime()).toBe(3_600_000)
  })

  it('retires outstanding tokens when a new one is issued', async () => {
    state.user = ACTIVE_USER

    await requestPasswordReset('chidi@sunrise.test', NOW)

    const sweep = callsOf('tx.passwordResetToken.updateMany')
    expect(sweep).toHaveLength(1)
    expect(sweep[0].args).toMatchObject({
      where: { userId: 'usr_1', usedAt: null },
      data: { usedAt: NOW }
    })
  })

  it('returns null for an unknown email and does not throw', async () => {
    state.user = null

    const result = await requestPasswordReset('nobody@nowhere.test', NOW)

    expect(result).toEqual({ resetUrl: null, fullName: null })
    expect(callsOf('$transaction')).toHaveLength(0)
  })

  it('returns null for a deactivated user, so a removed agent cannot reset back in', async () => {
    state.user = { ...ACTIVE_USER, disabledAt: new Date('2026-08-01T00:00:00.000Z') }

    const result = await requestPasswordReset('chidi@sunrise.test', NOW)

    expect(result).toEqual({ resetUrl: null, fullName: null })
    expect(callsOf('tx.passwordResetToken.create')).toHaveLength(0)
  })

  it('returns null when a token was already issued within the throttle window', async () => {
    state.user = ACTIVE_USER
    state.recentToken = { id: 'tok_recent' }

    const result = await requestPasswordReset('chidi@sunrise.test', NOW)

    expect(result).toEqual({ resetUrl: null, fullName: null })
    expect(callsOf('tx.passwordResetToken.create')).toHaveLength(0)
  })

  it('throttles on a 60-second window measured from `now`', async () => {
    state.user = ACTIVE_USER

    await requestPasswordReset('chidi@sunrise.test', NOW)

    const where = (callsOf('passwordResetToken.findFirst')[0].args as {
      where: { createdAt: { gt: Date }; usedAt: null; expiresAt: { gt: Date } }
    }).where
    expect(NOW.getTime() - where.createdAt.gt.getTime()).toBe(60_000)
    // A spent or expired token is not a reason to throttle — otherwise a user
    // who used their link an hour ago could not ask for another.
    expect(where.usedAt).toBeNull()
    expect(where.expiresAt.gt).toEqual(NOW)
  })

  it('makes the unknown-user and throttled paths indistinguishable to the caller', async () => {
    state.user = null
    const unknown = await requestPasswordReset('nobody@nowhere.test', NOW)

    state.user = ACTIVE_USER
    state.recentToken = { id: 'tok_recent' }
    const throttled = await requestPasswordReset('chidi@sunrise.test', NOW)

    state.recentToken = null
    state.user = { ...ACTIVE_USER, disabledAt: NOW }
    const deactivated = await requestPasswordReset('chidi@sunrise.test', NOW)

    expect(unknown).toEqual(throttled)
    expect(throttled).toEqual(deactivated)
  })

  it('looks the email up lowercased and trimmed', async () => {
    state.user = ACTIVE_USER

    await requestPasswordReset('  Chidi@Sunrise.TEST ', NOW)

    expect(callsOf('user.findUnique')[0].args).toMatchObject({
      where: { email: 'chidi@sunrise.test' }
    })
  })
})

describe('resetPassword', () => {
  const RAW = 'a-raw-token-value'
  const USABLE = {
    id: 'tok_1',
    userId: 'usr_1',
    expiresAt: new Date(NOW.getTime() + 60_000),
    usedAt: null,
    user: { disabledAt: null }
  }
  const INVALID_MESSAGE = 'This reset link is invalid or has expired.'

  async function messageFor(token: typeof state.token): Promise<string> {
    state.token = token
    try {
      await resetPassword(RAW, 'newpassword123', NOW)
      return '(did not throw)'
    } catch (error) {
      return (error as Error).message
    }
  }

  it('looks the token up by its hash, never by its raw value', async () => {
    state.token = USABLE

    await resetPassword(RAW, 'newpassword123', NOW)

    expect(callsOf('passwordResetToken.findUnique')[0].args).toMatchObject({
      where: { tokenHash: hashResetToken(RAW) }
    })
    expect(JSON.stringify(calls)).not.toContain(RAW)
  })

  it('sets a bcrypt hash and stamps passwordChangedAt', async () => {
    state.token = USABLE

    await resetPassword(RAW, 'newpassword123', NOW)

    const update = callsOf('tx.user.update')[0].args as {
      where: { id: string }
      data: { passwordHash: string; passwordChangedAt: Date }
    }
    expect(update.where.id).toBe('usr_1')
    expect(update.data.passwordChangedAt).toEqual(NOW)
    expect(update.data.passwordHash).toMatch(/^\$2[aby]\$10\$/)
    expect(await bcrypt.compare('newpassword123', update.data.passwordHash)).toBe(true)
  })

  it('spends the token and every other outstanding one in the same transaction', async () => {
    state.token = USABLE

    await resetPassword(RAW, 'newpassword123', NOW)

    expect(callsOf('$transaction')).toHaveLength(1)
    const updates = callsOf('tx.passwordResetToken.updateMany')
    expect(updates).toHaveLength(2)
    // The claim, conditional on the row still being unspent.
    expect(updates[0].args).toMatchObject({
      where: { id: 'tok_1', usedAt: null },
      data: { usedAt: NOW }
    })
    // The sweep of the user's other links.
    expect(updates[1].args).toMatchObject({
      where: { userId: 'usr_1', usedAt: null },
      data: { usedAt: NOW }
    })
  })

  it('gives one identical message for unknown, expired, used and deactivated', async () => {
    const unknown = await messageFor(null)
    const expired = await messageFor({ ...USABLE, expiresAt: new Date(NOW.getTime() - 1) })
    const used = await messageFor({ ...USABLE, usedAt: new Date(NOW.getTime() - 1000) })
    const deactivated = await messageFor({ ...USABLE, user: { disabledAt: NOW } })

    expect(unknown).toBe(INVALID_MESSAGE)
    expect(expired).toBe(INVALID_MESSAGE)
    expect(used).toBe(INVALID_MESSAGE)
    expect(deactivated).toBe(INVALID_MESSAGE)
    expect(new Set([unknown, expired, used, deactivated]).size).toBe(1)
  })

  it('rejects with a VALIDATION code, not NOT_FOUND, for an unknown token', async () => {
    // NOT_FOUND would leak through the code even with the message equalised.
    state.token = null
    await expect(resetPassword(RAW, 'newpassword123', NOW)).rejects.toMatchObject({
      code: 'VALIDATION'
    })
  })

  it('writes nothing when the token is not usable', async () => {
    state.token = { ...USABLE, usedAt: new Date(NOW.getTime() - 1) }

    await expect(resetPassword(RAW, 'newpassword123', NOW)).rejects.toThrow(ServiceError)
    expect(callsOf('$transaction')).toHaveLength(0)
  })

  it('refuses a replay that loses the race for the token', async () => {
    // The row passed the read but another submission spent it first, so the
    // conditional claim matches nothing. Single use has to hold here too.
    state.token = USABLE
    state.claimedCount = 0

    await expect(resetPassword(RAW, 'newpassword123', NOW)).rejects.toThrow(INVALID_MESSAGE)
  })

  it('rejects a password shorter than eight characters before touching the token', async () => {
    state.token = USABLE

    await expect(resetPassword(RAW, 'short', NOW)).rejects.toThrow('Use at least 8 characters')
    expect(callsOf('passwordResetToken.findUnique')).toHaveLength(0)
  })
})

describe('changePassword', () => {
  let currentHash = ''

  beforeEach(async () => {
    currentHash = await bcrypt.hash('password123', 10)
    state.userForChange = { passwordHash: currentHash, disabledAt: null }
  })

  it('changes the password when the current one is right', async () => {
    await changePassword('usr_1', 'password123', 'newpassword456', NOW)

    const update = callsOf('tx.user.update')[0].args as {
      data: { passwordHash: string; passwordChangedAt: Date }
    }
    expect(update.data.passwordChangedAt).toEqual(NOW)
    expect(await bcrypt.compare('newpassword456', update.data.passwordHash)).toBe(true)
  })

  it('invalidates outstanding reset tokens too', async () => {
    await changePassword('usr_1', 'password123', 'newpassword456', NOW)

    expect(callsOf('tx.passwordResetToken.updateMany')[0].args).toMatchObject({
      where: { userId: 'usr_1', usedAt: null },
      data: { usedAt: NOW }
    })
  })

  it('rejects a wrong current password and writes nothing', async () => {
    await expect(
      changePassword('usr_1', 'wrongpassword', 'newpassword456', NOW)
    ).rejects.toThrow('Your current password is incorrect.')
    expect(callsOf('$transaction')).toHaveLength(0)
  })

  it('rejects a no-op change', async () => {
    await expect(
      changePassword('usr_1', 'password123', 'password123', NOW)
    ).rejects.toThrow('Your new password must be different from your current one.')
    expect(callsOf('$transaction')).toHaveLength(0)
  })

  it('rejects a new password shorter than eight characters', async () => {
    await expect(changePassword('usr_1', 'password123', 'short', NOW)).rejects.toThrow(
      'Use at least 8 characters'
    )
  })

  it('rejects a deactivated account', async () => {
    state.userForChange = { passwordHash: currentHash, disabledAt: NOW }

    await expect(
      changePassword('usr_1', 'password123', 'newpassword456', NOW)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects a user that no longer exists', async () => {
    state.userForChange = null

    await expect(
      changePassword('usr_1', 'password123', 'newpassword456', NOW)
    ).rejects.toThrow(ServiceError)
  })
})
