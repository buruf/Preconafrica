import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthError } from 'next-auth'
import { RATE_LIMIT_MESSAGE, SIGN_IN, SIGN_IN_SOURCE, identifierKey, sourceKey, tierKey } from '@/domain/rate-limit'

/**
 * The limiter against its storage, and the login form against the limiter.
 *
 * `@/server/db` is mocked with an in-memory table that implements the *exact*
 * semantics of the `INSERT … ON CONFLICT DO UPDATE` in rate-limit.ts — insert,
 * increment, and reset-on-rolled-window — so these tests exercise the real
 * decision path, the real key construction and the real action wiring, and only
 * the Postgres round trip is faked. The one thing a fake cannot show is that
 * the statement is atomic under real concurrency; that property is pinned by a
 * source guard at the bottom of this file instead.
 */

interface Row {
  key: string
  windowStart: Date
  count: number
  expiresAt: Date
}

const table = new Map<string, Row>()

/** Every `$queryRaw` the limiter issued, so the shape of the SQL can be asserted. */
const rawStatements: string[] = []

vi.mock('@/server/db', () => ({
  prisma: {
    rateLimitHit: {
      findMany: vi.fn(async (args: { where: { key: { in: string[] } } }) => {
        return args.where.key.in
          .map((key) => table.get(key))
          .filter((row): row is Row => row !== undefined)
          .map((row) => ({ key: row.key, count: row.count, windowStart: row.windowStart }))
      }),
      deleteMany: vi.fn(async (args: { where: { expiresAt: { lte: Date } } }) => {
        let count = 0
        for (const [key, row] of [...table.entries()]) {
          if (row.expiresAt.getTime() <= args.where.expiresAt.lte.getTime()) {
            table.delete(key)
            count += 1
          }
        }
        return { count }
      })
    },
    // The tagged-template form. The parameter order is the one the statement in
    // rate-limit.ts uses: key, now, expires, floor.
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      rawStatements.push(strings.join('?'))
      const [key, now, expires, floor] = values as [string, Date, Date, Date]
      const existing = table.get(key)
      const rolled = existing !== undefined && existing.windowStart.getTime() <= floor.getTime()

      const row: Row =
        existing === undefined || rolled
          ? { key, windowStart: now, count: 1, expiresAt: expires }
          : { ...existing, count: existing.count + 1 }

      table.set(key, row)
      return Promise.resolve([{ count: row.count, windowStart: row.windowStart }])
    },
    $transaction: (work: Promise<unknown>[]) => Promise.all(work)
  }
}))

const HEADERS = {
  forwardedFor: '198.51.100.7' as string | null,
  /** Next throws this exact way when `headers()` is reached outside a request. */
  outsideRequestScope: false
}

vi.mock('next/headers', () => ({
  headers: () => {
    if (HEADERS.outsideRequestScope) {
      throw new Error('`headers` was called outside a request scope.')
    }
    return new Headers(HEADERS.forwardedFor ? { 'x-forwarded-for': HEADERS.forwardedFor } : {})
  }
}))

/** What the next `signIn` call should do. */
const signInOutcome = { mode: 'reject' as 'reject' | 'succeed' }

/**
 * A successful `signIn` never returns — it leaves by throwing Next's redirect
 * signal, which is not an AuthError. That is the whole mechanism by which a
 * successful sign-in escapes being counted, so the fake reproduces it rather
 * than returning a value the real one never returns.
 */
class RedirectSignal extends Error {
  digest = 'NEXT_REDIRECT;replace;/;307;'
}

const signIn = vi.fn(async () => {
  if (signInOutcome.mode === 'succeed') throw new RedirectSignal('NEXT_REDIRECT')
  throw new AuthError('CredentialsSignin')
})

vi.mock('@/server/auth', () => ({ signIn: (...args: unknown[]) => signIn(...(args as [])) }))

const { checkRateLimit, clientIp, recordRateLimitHit, purgeExpiredRateLimitHits, signInScopes } =
  await import('@/server/rate-limit')
const { loginAction } = await import('@/app/(auth)/login/actions')

const INCORRECT = 'Email or password is incorrect.'
const T0 = new Date('2026-08-16T09:00:00.000Z')

function credentials(email: string, password = 'wrong-password'): FormData {
  const form = new FormData()
  form.set('email', email)
  form.set('password', password)
  return form
}

/** One trip through the sign-in form. Returns whatever the user would see. */
async function signInAttempt(email: string, succeeds = false): Promise<string | undefined> {
  signInOutcome.mode = succeeds ? 'succeed' : 'reject'
  if (!succeeds) return loginAction(undefined, credentials(email))

  // The success path rethrows the redirect, exactly as the real action does.
  await expect(loginAction(undefined, credentials(email, 'password123'))).rejects.toThrow(
    'NEXT_REDIRECT'
  )
  return undefined
}

function burstCountFor(email: string, ip = '198.51.100.7'): number {
  return table.get(tierKey(identifierKey(SIGN_IN, email, ip), SIGN_IN.tiers[0]))?.count ?? 0
}

beforeEach(() => {
  table.clear()
  rawStatements.length = 0
  HEADERS.forwardedFor = '198.51.100.7'
  HEADERS.outsideRequestScope = false
  signInOutcome.mode = 'reject'
  signIn.mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a burst of failed sign-ins', () => {
  it('is allowed up to the budget and then refused', async () => {
    const seen: (string | undefined)[] = []
    for (let i = 0; i < SIGN_IN.tiers[0].limit + 2; i += 1) {
      seen.push(await signInAttempt('admin@sunrise.test'))
    }

    // Five wrong passwords are answered as wrong passwords…
    expect(seen.slice(0, SIGN_IN.tiers[0].limit)).toEqual(
      Array(SIGN_IN.tiers[0].limit).fill(INCORRECT)
    )
    // …and everything after that is refused before it reaches the provider.
    expect(seen.slice(SIGN_IN.tiers[0].limit)).toEqual([RATE_LIMIT_MESSAGE, RATE_LIMIT_MESSAGE])
  })

  it('stops calling the credentials provider once refused', async () => {
    for (let i = 0; i < SIGN_IN.tiers[0].limit; i += 1) await signInAttempt('admin@sunrise.test')
    expect(signIn).toHaveBeenCalledTimes(SIGN_IN.tiers[0].limit)

    // A refused attempt must cost no bcrypt work — which is also what keeps a
    // throttled response from being distinguishable by how long it took.
    signIn.mockClear()
    expect(await signInAttempt('admin@sunrise.test')).toBe(RATE_LIMIT_MESSAGE)
    expect(signIn).not.toHaveBeenCalled()
  })

  it('lets the account back in once the window has rolled', async () => {
    for (let i = 0; i <= SIGN_IN.tiers[0].limit; i += 1) await signInAttempt('admin@sunrise.test')
    expect(await signInAttempt('admin@sunrise.test')).toBe(RATE_LIMIT_MESSAGE)

    vi.setSystemTime(new Date(T0.getTime() + SIGN_IN.tiers[0].windowMs + 1_000))

    // Back to being told the password is wrong, rather than being throttled.
    expect(await signInAttempt('admin@sunrise.test')).toBe(INCORRECT)
    // And the counter restarted rather than resuming where it left off.
    expect(burstCountFor('admin@sunrise.test')).toBe(1)
  })
})

describe('a successful sign-in', () => {
  it('is not counted against the budget', async () => {
    await signInAttempt('admin@sunrise.test')
    await signInAttempt('admin@sunrise.test')
    await signInAttempt('admin@sunrise.test')
    expect(burstCountFor('admin@sunrise.test')).toBe(3)

    for (let i = 0; i < 20; i += 1) await signInAttempt('admin@sunrise.test', true)

    expect(burstCountFor('admin@sunrise.test')).toBe(3)
  })

  it('never refuses a user who keeps signing in correctly', async () => {
    // Twenty correct sign-ins in a minute is a shared kiosk, not an attack.
    for (let i = 0; i < 20; i += 1) {
      await expect(signInAttempt('admin@sunrise.test', true)).resolves.toBeUndefined()
    }
    expect(await signInAttempt('admin@sunrise.test')).toBe(INCORRECT)
  })

  it('does not refund the failures that came before it', async () => {
    // Not counting a success is not the same as forgiving what preceded it. If
    // it were, an attacker with one valid account of their own could clear the
    // per-source counter between every round of guesses.
    for (let i = 0; i < SIGN_IN.tiers[0].limit - 1; i += 1) {
      await signInAttempt('admin@sunrise.test')
    }
    await signInAttempt('admin@sunrise.test', true)

    expect(await signInAttempt('admin@sunrise.test')).toBe(INCORRECT)
    expect(await signInAttempt('admin@sunrise.test')).toBe(RATE_LIMIT_MESSAGE)
  })

  it('is refused too, once the budget is already spent', async () => {
    // A throttle that let the right password through would be no throttle at
    // all — the whole attack is guessing until the password *is* right. The
    // cost is that a user who mistypes five times waits out the minute, which
    // is why the window is a minute and not an hour.
    for (let i = 0; i <= SIGN_IN.tiers[0].limit; i += 1) await signInAttempt('admin@sunrise.test')
    signInOutcome.mode = 'succeed'
    expect(await loginAction(undefined, credentials('admin@sunrise.test', 'password123'))).toBe(
      RATE_LIMIT_MESSAGE
    )

    vi.setSystemTime(new Date(T0.getTime() + SIGN_IN.tiers[0].windowMs + 1_000))
    await expect(signInAttempt('admin@sunrise.test', true)).resolves.toBeUndefined()
  })
})

describe('one attacker cannot lock a legitimate user out', () => {
  it('keeps the victim signing in from their own address while the attacker is throttled', async () => {
    HEADERS.forwardedFor = '203.0.113.9' // the attacker
    for (let i = 0; i <= SIGN_IN.tiers[0].limit; i += 1) await signInAttempt('admin@sunrise.test')
    expect(await signInAttempt('admin@sunrise.test')).toBe(RATE_LIMIT_MESSAGE)

    HEADERS.forwardedFor = '198.51.100.7' // the real admin, from the office
    expect(await signInAttempt('admin@sunrise.test')).toBe(INCORRECT)
    await expect(signInAttempt('admin@sunrise.test', true)).resolves.toBeUndefined()
  })

  it('does not spend one account’s budget on another account', async () => {
    for (let i = 0; i <= SIGN_IN.tiers[0].limit; i += 1) await signInAttempt('admin@sunrise.test')
    expect(await signInAttempt('admin@sunrise.test')).toBe(RATE_LIMIT_MESSAGE)

    expect(await signInAttempt('kwame@buyer.test')).toBe(INCORRECT)
  })
})

describe('the per-source counter', () => {
  it('catches a spray across many accounts that no single account would notice', async () => {
    // Four attempts each against eight different addresses: every per-account
    // counter stays under its budget of five, and only the source tier sees it.
    const perSourceBudget = SIGN_IN_SOURCE.tiers[0].limit
    let refusedAt: number | null = null

    for (let i = 0; i < perSourceBudget + 4 && refusedAt === null; i += 1) {
      const answer = await signInAttempt(`victim${Math.floor(i / 4)}@sunrise.test`)
      if (answer === RATE_LIMIT_MESSAGE) refusedAt = i
    }

    expect(refusedAt).toBe(perSourceBudget)
    // Confirms it really was the source tier: no per-account counter got near
    // its own budget of five.
    expect(burstCountFor('victim0@sunrise.test')).toBeLessThanOrEqual(SIGN_IN.tiers[0].limit)
    expect(table.get(tierKey(sourceKey(SIGN_IN_SOURCE, '198.51.100.7'), SIGN_IN_SOURCE.tiers[0]))?.count).toBe(
      perSourceBudget
    )
  })
})

describe('enumeration resistance', () => {
  it('throttles a registered and an unregistered address identically', async () => {
    // Nothing in this path ever looks an address up, so the two must be
    // byte-identical at every step — a throttle message that appeared only for
    // real accounts would be the oracle the generic wording exists to prevent.
    const real: (string | undefined)[] = []
    const invented: (string | undefined)[] = []

    HEADERS.forwardedFor = '198.51.100.7'
    for (let i = 0; i < SIGN_IN.tiers[0].limit + 2; i += 1) {
      real.push(await signInAttempt('admin@sunrise.test'))
    }

    HEADERS.forwardedFor = '198.51.100.8'
    for (let i = 0; i < SIGN_IN.tiers[0].limit + 2; i += 1) {
      invented.push(await signInAttempt('nobody-at-all@nowhere.invalid'))
    }

    expect(invented).toEqual(real)
  })
})

describe('the counters themselves', () => {
  it('gives each tier of each scope its own row', async () => {
    await signInAttempt('admin@sunrise.test')

    expect([...table.keys()].sort()).toEqual(
      [
        ...SIGN_IN.tiers.map((tier) =>
          tierKey(identifierKey(SIGN_IN, 'admin@sunrise.test', '198.51.100.7'), tier)
        ),
        ...SIGN_IN_SOURCE.tiers.map((tier) =>
          tierKey(sourceKey(SIGN_IN_SOURCE, '198.51.100.7'), tier)
        )
      ].sort()
    )
  })

  it('costs a refused attempt no write at all', async () => {
    for (let i = 0; i <= SIGN_IN.tiers[0].limit; i += 1) await signInAttempt('admin@sunrise.test')

    const before = rawStatements.length
    await signInAttempt('admin@sunrise.test')
    // Someone hammering a throttled endpoint must not be able to make us write
    // a row per attempt: the check is a read, and the write only follows an
    // attempt that was allowed through.
    expect(rawStatements.length).toBe(before)
  })

  it('increments in one statement, so two concurrent attempts cannot both read a stale count', () => {
    // The fake store above is single-threaded, so it cannot demonstrate this.
    // Pin the property at the source instead: the increment must be one
    // `INSERT … ON CONFLICT DO UPDATE` doing its own arithmetic in SQL, never
    // a read followed by a write.
    const source = readFileSync(path.resolve(__dirname, '../rate-limit.ts'), 'utf8')
    expect(source).toContain('ON CONFLICT ("key") DO UPDATE SET')
    expect(source).toContain('"RateLimitHit"."count" + 1')
    expect(source).toMatch(/RETURNING "count", "windowStart"/)
  })

  it('fails open when the table cannot be read', async () => {
    // A blip on this one table must not lock every user out of a system of
    // record. The credential check is untouched, so an allowed request still
    // has to present a correct password.
    const { prisma } = await import('@/server/db')
    vi.mocked(prisma.rateLimitHit.findMany).mockRejectedValueOnce(new Error('connection reset'))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    const decision = await checkRateLimit(signInScopes('admin@sunrise.test', '198.51.100.7'), T0)

    expect(decision.allowed).toBe(true)
    // …and loudly, because a limiter that is quietly not limiting is worse
    // than one that is obviously broken.
    expect(quiet).toHaveBeenCalled()
    quiet.mockRestore()
  })
})

describe('reading the source address', () => {
  it('takes only the first entry of the forwarded chain', () => {
    HEADERS.forwardedFor = '198.51.100.7, 10.0.0.1'
    expect(clientIp()).toBe('198.51.100.7')
  })

  it('falls back to the shared bucket when there is no header', () => {
    HEADERS.forwardedFor = null
    expect(clientIp()).toBe('unknown')
  })

  it('never throws, so it cannot change the shape of the call it guards', async () => {
    // `headers()` throws outside a request scope. An uncaught throw here would
    // turn an action with one carefully uniform exit into one that can also
    // blow up — and an action that errors for some callers and redirects for
    // others is the oracle the uniform exit exists to remove. Not knowing
    // where a request came from is the cheaper failure, so it is the one taken.
    HEADERS.outsideRequestScope = true

    expect(clientIp()).toBe('unknown')
    // And the surface it guards still behaves: throttled on its own schedule,
    // in the shared bucket, rather than erroring.
    expect(await signInAttempt('admin@sunrise.test')).toBe(INCORRECT)
    expect(burstCountFor('admin@sunrise.test', 'unknown')).toBe(1)
  })
})

describe('the reaper', () => {
  it('deletes counters whose window is over and leaves live ones alone', async () => {
    const scopes = signInScopes('admin@sunrise.test', '198.51.100.7')
    await recordRateLimitHit(scopes, T0)
    expect(table.size).toBe(4) // two tiers on each of two scopes

    // Past the minute tier's expiry but not the hour's.
    const purged = await purgeExpiredRateLimitHits(new Date(T0.getTime() + 61_000))

    expect(purged).toBe(2)
    expect(table.size).toBe(2)
    for (const row of table.values()) {
      expect(row.key).toContain('#hour')
    }
  })

  it('reaps everything once every window is over', async () => {
    await recordRateLimitHit(signInScopes('admin@sunrise.test', '198.51.100.7'), T0)
    await purgeExpiredRateLimitHits(new Date(T0.getTime() + 2 * 60 * 60_000))
    expect(table.size).toBe(0)
  })

  it('is wired into the daily cron rather than a second scheduled job', () => {
    const route = readFileSync(
      path.resolve(__dirname, '../../app/api/cron/reminders/route.ts'),
      'utf8'
    )
    expect(route).toContain('purgeExpiredRateLimitHits')

    const crons = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../vercel.json'), 'utf8')
    ) as { crons: { path: string }[] }
    expect(crons.crons).toHaveLength(1)
  })
})
