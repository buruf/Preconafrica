import { describe, expect, it } from 'vitest'
import {
  PasswordSchema,
  RESET_TOKEN_TTL_MS,
  confirmationMatches,
  hashResetToken,
  isResetTokenUsable,
  sessionOutdatedByPasswordChange
} from '@/domain/password-reset'

describe('hashResetToken', () => {
  it('is stable for the same input', () => {
    expect(hashResetToken('abc')).toBe(hashResetToken('abc'))
  })

  it('produces a 64-character lowercase hex digest', () => {
    expect(hashResetToken('abc')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('separates inputs that differ by a single character', () => {
    expect(hashResetToken('abc')).not.toBe(hashResetToken('abd'))
  })

  it('does not contain the input it hashed', () => {
    // The point of storing the digest rather than the token: the row a
    // database leak exposes must not be something an attacker can replay at
    // /reset-password, and must not read as the token with extra characters
    // around it either.
    const raw = 'PsC9lcHZ7t4mS0nHkE8b'
    const hash = hashResetToken(raw)
    expect(hash).not.toContain(raw)
    expect(hash).not.toContain(raw.toLowerCase())
    expect(hash.length).toBe(64)
  })

  it('gives long, near-identical inputs completely different digests', () => {
    const a = hashResetToken('a'.repeat(64))
    const b = hashResetToken(`${'a'.repeat(63)}b`)
    expect(a).not.toBe(b)
    // No shared prefix worth speaking of — a truncated-comparison bug would
    // otherwise treat these as the same token.
    expect(a.slice(0, 8)).not.toBe(b.slice(0, 8))
  })
})

describe('RESET_TOKEN_TTL_MS', () => {
  it('is one hour, which is what the email and the pages promise', () => {
    expect(RESET_TOKEN_TTL_MS).toBe(3_600_000)
    expect(RESET_TOKEN_TTL_MS / 60_000).toBe(60)
  })
})

describe('isResetTokenUsable', () => {
  const now = new Date('2026-08-11T12:00:00.000Z')
  const inAnHour = new Date(now.getTime() + RESET_TOKEN_TTL_MS)

  it('accepts an unused, unexpired token', () => {
    expect(isResetTokenUsable({ expiresAt: inAnHour, usedAt: null }, now)).toBe(true)
  })

  it('rejects an expired token', () => {
    const expired = new Date(now.getTime() - 1)
    expect(isResetTokenUsable({ expiresAt: expired, usedAt: null }, now)).toBe(false)
  })

  it('rejects a token that has already been used', () => {
    expect(isResetTokenUsable({ expiresAt: inAnHour, usedAt: now }, now)).toBe(false)
  })

  it('rejects a token whose expiry is exactly now', () => {
    // The boundary belongs to the expired side: at expiresAt the hour is over.
    expect(isResetTokenUsable({ expiresAt: now, usedAt: null }, now)).toBe(false)
  })

  it('accepts a token with one millisecond left', () => {
    const barely = new Date(now.getTime() + 1)
    expect(isResetTokenUsable({ expiresAt: barely, usedAt: null }, now)).toBe(true)
  })

  it('rejects a used token even when it has not expired', () => {
    const usedEarlier = new Date(now.getTime() - 10_000)
    expect(isResetTokenUsable({ expiresAt: inAnHour, usedAt: usedEarlier }, now)).toBe(false)
  })
})

describe('sessionOutdatedByPasswordChange', () => {
  // 2026-08-11T12:00:00Z as whole seconds, the unit a JWT's `iat` uses.
  const issuedAt = Math.floor(new Date('2026-08-11T12:00:00.000Z').getTime() / 1000)

  it('keeps a session when the password has never been changed', () => {
    expect(sessionOutdatedByPasswordChange(null, issuedAt)).toBe(false)
  })

  it('revokes a session issued before the change', () => {
    const changedAt = new Date((issuedAt + 30) * 1000)
    expect(sessionOutdatedByPasswordChange(changedAt, issuedAt)).toBe(true)
  })

  it('keeps a session issued after the change', () => {
    const changedAt = new Date((issuedAt - 30) * 1000)
    expect(sessionOutdatedByPasswordChange(changedAt, issuedAt)).toBe(false)
  })

  it('revokes a session issued in the same second as the change', () => {
    // The granularity trap this function exists for. `iat` is whole seconds
    // and passwordChangedAt is milliseconds, so a change 900ms into the second
    // the token was issued must still count as invalidating — otherwise the
    // one token an attacker racing the reset would hold is the one that
    // survives it.
    const changedAt = new Date(issuedAt * 1000 + 900)
    expect(sessionOutdatedByPasswordChange(changedAt, issuedAt)).toBe(true)
  })

  it('revokes when the change is exactly on the second boundary', () => {
    expect(sessionOutdatedByPasswordChange(new Date(issuedAt * 1000), issuedAt)).toBe(true)
  })

  it('keeps a session issued one second after the change', () => {
    const changedAt = new Date(issuedAt * 1000 + 900)
    expect(sessionOutdatedByPasswordChange(changedAt, issuedAt + 1)).toBe(false)
  })

  it('revokes when the token carries no issued-at claim', () => {
    // Fail closed: if we cannot prove the session postdates the change, it
    // goes. The cost is one extra sign-in; the alternative is a session the
    // reset was supposed to kill.
    expect(sessionOutdatedByPasswordChange(new Date(issuedAt * 1000), undefined)).toBe(true)
  })

  it('keeps a session with no issued-at claim when nothing has changed', () => {
    // Nothing to revoke against, so a missing claim is not on its own a reason
    // to sign anyone out — otherwise no one could ever stay signed in.
    expect(sessionOutdatedByPasswordChange(null, undefined)).toBe(false)
  })

  it('revokes when the issued-at claim is not a finite number', () => {
    expect(sessionOutdatedByPasswordChange(new Date(issuedAt * 1000), Number.NaN)).toBe(true)
  })
})

describe('PasswordSchema', () => {
  it('accepts eight characters', () => {
    expect(PasswordSchema.safeParse('12345678').success).toBe(true)
  })

  it('rejects seven', () => {
    expect(PasswordSchema.safeParse('1234567').success).toBe(false)
  })

  it('rejects an empty password', () => {
    expect(PasswordSchema.safeParse('').success).toBe(false)
  })

  it('gives the same message the signup forms already give', () => {
    // Deliberately identical to CreateAgentSchema's and buyer registration's,
    // so a password acceptable at signup is acceptable at reset and the app
    // never enforces two definitions of "strong enough" at once.
    const parsed = PasswordSchema.safeParse('short')
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe('Use at least 8 characters')
    }
  })

  it('does not silently trim, so no character of a password is dropped', () => {
    expect(PasswordSchema.parse(' password123 ')).toBe(' password123 ')
  })
})

describe('confirmationMatches', () => {
  it('accepts two identical entries', () => {
    expect(confirmationMatches('password123', 'password123')).toBe(true)
  })

  it('rejects a mismatch', () => {
    expect(confirmationMatches('password123', 'password124')).toBe(false)
  })

  it('rejects a difference of case only', () => {
    expect(confirmationMatches('Password123', 'password123')).toBe(false)
  })

  it('rejects a difference of trailing whitespace only', () => {
    // Not trimmed on purpose: a trailing space is part of the password, and
    // quietly accepting the pair would set a password the user cannot retype.
    expect(confirmationMatches('password123 ', 'password123')).toBe(false)
  })

  it('rejects an empty confirmation', () => {
    expect(confirmationMatches('password123', '')).toBe(false)
  })
})
