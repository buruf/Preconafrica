import { encode, decode } from '@auth/core/jwt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionOutdatedByPasswordChange } from '@/domain/password-reset'

/**
 * The guard whose absence let a critical bug through.
 *
 * `requireUser` revokes a session by comparing the moment it began against
 * `User.passwordChangedAt`. That only works if the claim carrying "when this
 * session began" actually survives a session read — and Auth.js re-signs the
 * JWT on *every* read, handing the refreshed cookie back to the browser (via
 * the public `GET /api/auth/session` and via the middleware, which attaches
 * `set-cookie` even to the redirect that bounced the request).
 *
 * `jwt.encode` calls `.setIssuedAt()`, so `iat` is rewritten to "now" each
 * time. Reading it made revocation self-healing: one request with a stolen
 * cookie bought a fresh `iat`, and the comparison never fired again.
 *
 * These tests run the real `@auth/core/jwt` — the same code path Auth.js uses
 * — through encode → decode → encode → decode, which is exactly a sign-in
 * followed by one session read. `authTime` must come out the far side
 * untouched; `iat` must be seen to move, so that nobody "simplifies" the
 * session callback back onto it without a red test.
 */

const SECRET = 'a-test-secret-that-is-comfortably-long-enough'
const SALT = 'authjs.session-token'
const MAX_AGE = 60 * 60 * 24 * 7

const START = new Date('2026-08-11T12:00:00.000Z')

/**
 * `@auth/core`'s JWT type is an open bag of `unknown` claims — the typed
 * augmentation in types/next-auth.d.ts applies to `next-auth/jwt`, a different
 * module. Narrowing here rather than casting at each call site keeps the
 * assertions readable, and asserts the claim really is a number on the way
 * past.
 */
function seconds(claim: unknown): number | undefined {
  if (claim === undefined) return undefined
  expect(typeof claim).toBe('number')
  return claim as number
}

/** What the jwt callback produces at sign-in, and returns unchanged after. */
function signInToken() {
  return {
    sub: 'usr_1',
    orgId: 'org_1',
    role: 'AGENT' as const,
    buyerId: null,
    authTime: Math.floor(Date.now() / 1000)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('JWT claims across a session read', () => {
  it('preserves authTime and rotates iat through encode/decode/encode/decode', async () => {
    const atSignIn = signInToken()

    const first = await encode({ token: atSignIn, secret: SECRET, salt: SALT, maxAge: MAX_AGE })
    const decodedFirst = await decode({ token: first, secret: SECRET, salt: SALT })
    expect(decodedFirst).not.toBeNull()

    // A session read: Auth.js runs the jwt callback (which, with no `user`,
    // returns the token as-is) and re-encodes it. Time has moved on.
    vi.setSystemTime(new Date(START.getTime() + 90_000))

    const second = await encode({
      token: decodedFirst as Record<string, unknown>,
      secret: SECRET,
      salt: SALT,
      maxAge: MAX_AGE
    })
    const decodedSecond = await decode({ token: second, secret: SECRET, salt: SALT })
    expect(decodedSecond).not.toBeNull()

    // The claim `requireUser` consumes is unchanged...
    expect(decodedSecond?.authTime).toBe(atSignIn.authTime)
    expect(decodedSecond?.authTime).toBe(decodedFirst?.authTime)

    // ...while `iat` has been rewritten to the time of the read. This half of
    // the assertion is the point: if a future @auth/core stops rotating `iat`,
    // this test failing is the signal that the reasoning above needs revisiting
    // — not permission to go back to reading it.
    expect(decodedSecond?.iat).not.toBe(decodedFirst?.iat)
    expect(decodedSecond?.iat).toBe(Math.floor((START.getTime() + 90_000) / 1000))
  })

  it('leaves the other session claims intact across the round trip', async () => {
    const first = await encode({ token: signInToken(), secret: SECRET, salt: SALT, maxAge: MAX_AGE })
    const decodedFirst = await decode({ token: first, secret: SECRET, salt: SALT })

    vi.setSystemTime(new Date(START.getTime() + 5_000))
    const second = await encode({
      token: decodedFirst as Record<string, unknown>,
      secret: SECRET,
      salt: SALT,
      maxAge: MAX_AGE
    })
    const decodedSecond = await decode({ token: second, secret: SECRET, salt: SALT })

    expect(decodedSecond).toMatchObject({ sub: 'usr_1', orgId: 'org_1', role: 'AGENT' })
  })

  it('still revokes a refreshed token that predates a password change', async () => {
    // The end-to-end statement of the bug: sign in, change the password a
    // minute later, then let the thief refresh the cookie. Reading the
    // refreshed `iat` would say "this session is newer than the change";
    // reading `authTime` says what actually happened.
    const atSignIn = signInToken()
    const first = await encode({ token: atSignIn, secret: SECRET, salt: SALT, maxAge: MAX_AGE })
    const decodedFirst = await decode({ token: first, secret: SECRET, salt: SALT })

    const passwordChangedAt = new Date(START.getTime() + 60_000)

    vi.setSystemTime(new Date(START.getTime() + 120_000))
    const refreshed = await decode({
      token: await encode({
        token: decodedFirst as Record<string, unknown>,
        secret: SECRET,
        salt: SALT,
        maxAge: MAX_AGE
      }),
      secret: SECRET,
      salt: SALT
    })

    expect(sessionOutdatedByPasswordChange(passwordChangedAt, seconds(refreshed?.authTime))).toBe(
      true
    )
    // What the old code did, kept here as the counter-example.
    expect(sessionOutdatedByPasswordChange(passwordChangedAt, seconds(refreshed?.iat))).toBe(false)
  })

  it('revokes a token minted before the authTime claim existed', async () => {
    // Fail closed: no provable start time means the session goes.
    const legacy = await encode({
      token: { sub: 'usr_1', orgId: 'org_1', role: 'AGENT', buyerId: null },
      secret: SECRET,
      salt: SALT,
      maxAge: MAX_AGE
    })
    const decoded = await decode({ token: legacy, secret: SECRET, salt: SALT })

    expect(decoded?.authTime).toBeUndefined()
    expect(
      sessionOutdatedByPasswordChange(new Date(START.getTime() - 1_000), seconds(decoded?.authTime))
    ).toBe(true)
  })
})
