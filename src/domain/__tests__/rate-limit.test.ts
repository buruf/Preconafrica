import { describe, expect, it } from 'vitest'
import {
  BUYER_REGISTRATION,
  RATE_LIMIT_MESSAGE,
  RESET_REQUEST,
  RESET_SUBMIT_SOURCE,
  SIGN_IN,
  SIGN_IN_SOURCE,
  clientIpFromForwardedFor,
  combineDecisions,
  decideRateLimit,
  identifierKey,
  sourceKey,
  tierKey,
  type RateLimitTier,
  type WindowState
} from '@/domain/rate-limit'

/**
 * The limiter's decision logic, tested as the pure function it is.
 *
 * Everything a rate limiter gets wrong is an edge: the attempt that is exactly
 * at the budget, the window that has just rolled, the counter that turns out to
 * be shared with another key. None of those are reachable through a database
 * without sleeping through real windows, which is why the arithmetic lives in
 * `@/domain` with the clock passed in.
 */

const T0 = new Date('2026-08-16T09:00:00.000Z').getTime()
const MINUTE = 60_000

const BURST: RateLimitTier = { name: 'burst', windowMs: MINUTE, limit: 3 }
const HOUR: RateLimitTier = { name: 'hour', windowMs: 60 * MINUTE, limit: 10 }

function at(count: number, startedMsAgo = 0): WindowState {
  return { count, windowStartMs: T0 - startedMsAgo }
}

describe('decideRateLimit', () => {
  it('allows an attempt when nothing has been counted yet', () => {
    expect(decideRateLimit([null, null], [BURST, HOUR], T0, 1)).toEqual({
      allowed: true,
      retryAfterMs: 0
    })
  })

  it('allows every attempt up to the budget', () => {
    // `pending: 1` asks "would one more fit?", so a window holding 2 of 3 is
    // still open and a window holding 3 of 3 is not.
    for (let count = 0; count < BURST.limit; count += 1) {
      expect(
        decideRateLimit([at(count)], [BURST], T0, 1).allowed,
        `${count} counted, one more must fit inside a budget of ${BURST.limit}`
      ).toBe(true)
    }
  })

  it('refuses the attempt that would exceed the budget', () => {
    const decision = decideRateLimit([at(BURST.limit)], [BURST], T0, 1)
    expect(decision.allowed).toBe(false)
    expect(decision.retryAfterMs).toBe(MINUTE)
  })

  it('judges a count that already includes the attempt with pending 0', () => {
    // This is the post-increment call: the atomic upsert returned "you are
    // number N". N == limit is the last allowed attempt; N == limit + 1 is not.
    expect(decideRateLimit([at(BURST.limit)], [BURST], T0, 0).allowed).toBe(true)
    expect(decideRateLimit([at(BURST.limit + 1)], [BURST], T0, 0).allowed).toBe(false)
  })

  it('rolls the window: an exhausted budget frees up once the window is over', () => {
    const exhausted = at(BURST.limit)

    // One millisecond before the window ends, still refused.
    expect(decideRateLimit([exhausted], [BURST], T0 + MINUTE - 1, 1).allowed).toBe(false)
    // At the window's end, the count is treated as zero again.
    expect(decideRateLimit([exhausted], [BURST], T0 + MINUTE, 1).allowed).toBe(true)
    expect(decideRateLimit([exhausted], [BURST], T0 + MINUTE * 5, 1).allowed).toBe(true)
  })

  it('reports how long is left on the window that blocked it', () => {
    const twentySeconds = 20_000
    const decision = decideRateLimit([at(BURST.limit, twentySeconds)], [BURST], T0, 1)
    expect(decision.retryAfterMs).toBe(MINUTE - twentySeconds)
  })

  it('refuses when any tier is exhausted, and waits out the longest one', () => {
    // Burst has room; the hourly budget does not. The answer is the hour.
    const decision = decideRateLimit([at(0), at(HOUR.limit, 10 * MINUTE)], [BURST, HOUR], T0, 1)
    expect(decision.allowed).toBe(false)
    expect(decision.retryAfterMs).toBe(50 * MINUTE)
  })

  it('keeps a rolled burst window from resurrecting an exhausted hourly budget', () => {
    // The reason two tiers exist: an attacker who waits out the minute must
    // still meet the hour.
    const states = [at(BURST.limit, 2 * MINUTE), at(HOUR.limit, 2 * MINUTE)]
    expect(decideRateLimit(states, [BURST, HOUR], T0, 1).allowed).toBe(false)
  })
})

describe('combineDecisions', () => {
  it('allows only when every counter allows', () => {
    expect(combineDecisions([{ allowed: true, retryAfterMs: 0 }]).allowed).toBe(true)
    expect(
      combineDecisions([
        { allowed: true, retryAfterMs: 0 },
        { allowed: false, retryAfterMs: 5_000 }
      ])
    ).toEqual({ allowed: false, retryAfterMs: 5_000 })
  })

  it('reports the longest wait among the counters that refused', () => {
    expect(
      combineDecisions([
        { allowed: false, retryAfterMs: 5_000 },
        { allowed: false, retryAfterMs: 90_000 }
      ]).retryAfterMs
    ).toBe(90_000)
  })
})

describe('counter keys', () => {
  it('gives two different identifiers two different counters', () => {
    expect(identifierKey(SIGN_IN, 'admin@sunrise.test', '198.51.100.7')).not.toBe(
      identifierKey(SIGN_IN, 'kwame@buyer.test', '198.51.100.7')
    )
  })

  it('gives one identifier a different counter per source', () => {
    // The anti-lockout property in one assertion: an attacker hammering
    // admin@sunrise.test from their own address cannot touch the counter the
    // real admin is measured by, because the source is part of the key.
    const attacker = identifierKey(SIGN_IN, 'admin@sunrise.test', '203.0.113.9')
    const owner = identifierKey(SIGN_IN, 'admin@sunrise.test', '198.51.100.7')
    expect(attacker).not.toBe(owner)
  })

  it('keeps the per-identifier and per-source counters independent', () => {
    const perIdentifier = identifierKey(SIGN_IN, 'admin@sunrise.test', '198.51.100.7')
    const perSource = sourceKey(SIGN_IN_SOURCE, '198.51.100.7')
    expect(perIdentifier).not.toBe(perSource)

    // And they are judged against their own budgets: a source counter sitting
    // at the per-identifier limit is nowhere near its own.
    expect(decideRateLimit([at(SIGN_IN.tiers[0].limit)], [SIGN_IN.tiers[0]], T0, 1).allowed).toBe(
      false
    )
    expect(
      decideRateLimit([at(SIGN_IN.tiers[0].limit)], [SIGN_IN_SOURCE.tiers[0]], T0, 1).allowed
    ).toBe(true)
  })

  it('never lets two policies share a counter', () => {
    const keys = [SIGN_IN, RESET_REQUEST, BUYER_REGISTRATION].map((policy) =>
      identifierKey(policy, 'admin@sunrise.test', '198.51.100.7')
    )
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('never lets two tiers of one policy share a counter', () => {
    const key = sourceKey(RESET_SUBMIT_SOURCE, '198.51.100.7')
    const keys = RESET_SUBMIT_SOURCE.tiers.map((tier) => tierKey(key, tier))
    expect(new Set(keys).size).toBe(RESET_SUBMIT_SOURCE.tiers.length)
  })

  it('treats an identifier case-insensitively and trims it', () => {
    expect(identifierKey(SIGN_IN, '  Admin@Sunrise.TEST ', '198.51.100.7')).toBe(
      identifierKey(SIGN_IN, 'admin@sunrise.test', '198.51.100.7')
    )
  })

  it('bounds the key length, since the key is a primary key', () => {
    const key = identifierKey(SIGN_IN, 'a'.repeat(5_000), 'b'.repeat(5_000))
    expect(key.length).toBeLessThan(400)
  })
})

describe('clientIpFromForwardedFor', () => {
  it('trusts only the first entry of the chain', () => {
    // Everything after the first hop is whatever the previous proxy claimed.
    expect(clientIpFromForwardedFor('198.51.100.7, 10.0.0.1, 172.16.0.4')).toBe('198.51.100.7')
  })

  it('tolerates whitespace', () => {
    expect(clientIpFromForwardedFor('  198.51.100.7 ,10.0.0.1')).toBe('198.51.100.7')
  })

  it('collapses a missing header into one shared bucket rather than escaping the limiter', () => {
    expect(clientIpFromForwardedFor(null)).toBe('unknown')
    expect(clientIpFromForwardedFor(undefined)).toBe('unknown')
    expect(clientIpFromForwardedFor('')).toBe('unknown')
    expect(clientIpFromForwardedFor('   ')).toBe('unknown')
  })
})

describe('the sentence a throttled user reads', () => {
  it('is a plain instruction, not a status code', () => {
    expect(RATE_LIMIT_MESSAGE).toBe('Too many attempts. Please wait a minute and try again.')
    expect(RATE_LIMIT_MESSAGE).not.toMatch(/429|rate.?limit|error/i)
  })
})

describe('the budgets themselves', () => {
  it('keeps the per-source budget looser than the per-account one', () => {
    // A source is not a person: an office or a carrier NAT puts many
    // legitimate users behind one address, and this must not be what stops the
    // fourth person in a sales office signing in.
    for (let i = 0; i < SIGN_IN.tiers.length; i += 1) {
      expect(SIGN_IN_SOURCE.tiers[i].windowMs).toBe(SIGN_IN.tiers[i].windowMs)
      expect(SIGN_IN_SOURCE.tiers[i].limit).toBeGreaterThan(SIGN_IN.tiers[i].limit)
    }
  })

  it('gives every policy a short burst tier and a longer sustained one', () => {
    for (const policy of [SIGN_IN, SIGN_IN_SOURCE, RESET_REQUEST, RESET_SUBMIT_SOURCE, BUYER_REGISTRATION]) {
      expect(policy.tiers.length, `${policy.name} needs two tiers`).toBe(2)
      const [burst, sustained] = policy.tiers
      expect(sustained.windowMs).toBeGreaterThan(burst.windowMs)
      expect(sustained.limit).toBeGreaterThan(burst.limit)
    }
  })

  it('throttles reset requests harder than sign-in, because each one costs an email', () => {
    expect(RESET_REQUEST.tiers[0].limit).toBeLessThan(SIGN_IN.tiers[0].limit)
  })
})
