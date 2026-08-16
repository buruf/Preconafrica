import { headers } from 'next/headers'
import { prisma } from '@/server/db'
import {
  ALLOWED,
  UNKNOWN_SOURCE,
  clientIpFromForwardedFor,
  combineDecisions,
  decideRateLimit,
  tierKey,
  type RateLimitDecision,
  type RateLimitScope,
  type WindowState
} from '@/domain/rate-limit'

export {
  RATE_LIMIT_MESSAGE,
  buyerRegistrationScopes,
  resetRequestScopes,
  resetSubmitScopes,
  signInScopes
} from '@/domain/rate-limit'
export type { RateLimitDecision, RateLimitScope } from '@/domain/rate-limit'

/**
 * The storage half of the rate limiter: Postgres, one row per (key, tier).
 *
 * Postgres rather than Redis, deliberately. This project runs no Redis and
 * adding a service — another dependency, another set of credentials, another
 * thing to be down at 2am — to count login attempts is out of proportion to
 * what is being defended. The database is already here, already transactional,
 * and a failed login is a write this app can afford: the alternative it
 * replaces is a bcrypt comparison at cost 10, which is far more expensive than
 * one indexed upsert.
 *
 * The in-memory alternative was never on the table. This deploys to Vercel,
 * where every instance has its own memory and cold starts are routine, so an
 * in-process counter is per-instance and resets whenever the platform feels
 * like it — which is no throttle at all, only the appearance of one.
 */

/**
 * The source address of the request being handled, for use as a counter key.
 *
 * Reading it is part of the limiter, so it obeys the limiter's rule: nothing
 * here may change the shape of the call it guards. `headers()` throws outside a
 * request scope, and an uncaught throw here would turn a server action with one
 * carefully uniform exit — /forgot-password, whose whole design is that every
 * outcome leaves at the same place after the same delay — into one that can
 * also blow up. That is a worse failure than not knowing where a request came
 * from, and it is a failure the throttled surface can least afford: an action
 * that errors for some inputs and redirects for others is exactly the oracle
 * the uniform exit exists to remove.
 *
 * So the fallback is the same shared bucket an absent header collapses to. A
 * request whose source cannot be discovered is throttled alongside every other
 * such request rather than escaping the limiter, and the per-identifier tier
 * still separates them by what was typed.
 */
export function clientIp(): string {
  try {
    return clientIpFromForwardedFor(headers().get('x-forwarded-for'))
  } catch {
    return UNKNOWN_SOURCE
  }
}

/**
 * FAIL OPEN. If the rate-limit table cannot be read or written, the request is
 * allowed and the failure is logged.
 *
 * The argument for failing closed is that an outage removes the throttle. It
 * loses here for one reason: the limiter shares its database with
 * authentication itself. If Postgres is unreachable, `authorize()`'s user
 * lookup fails too and nobody can sign in regardless — so failing closed buys
 * nothing in the case people imagine when they say "fail closed". The cases it
 * actually changes are the narrow ones where *only* this table is unhappy: a
 * lock timeout, a statement error after a schema change, a migration that has
 * not landed yet. In every one of those, failing closed means a database blip
 * on one small table locks every user out of a system of record their day
 * depends on — an outage we would have built ourselves, for a table whose whole
 * job is to make an attack slower.
 *
 * What is *not* given up by failing open: the credential check is untouched.
 * A caller who slips past a broken limiter still has to present a correct
 * bcrypt password, and the reset token still carries 256 bits of entropy. The
 * throttle is a speed bump on top of those, not a substitute for them, so
 * losing it during an incident degrades defence in depth rather than removing
 * the defence.
 */
async function failOpen<T>(label: string, fallback: T, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    // Loud, because a limiter that is quietly not limiting is worse than one
    // that is obviously broken.
    console.error(`[rate-limit] ${label} failed; allowing the request`, error)
    return fallback
  }
}

/**
 * Read the current windows for one scope, without touching them. Used for the
 * check taken *before* the work, so a refused request costs one indexed read
 * and no write — an attacker hammering a throttled endpoint must not be able to
 * make us write a row per attempt.
 */
async function peekScope(scope: RateLimitScope, now: Date): Promise<RateLimitDecision> {
  const keys = scope.policy.tiers.map((tier) => tierKey(scope.key, tier))
  const rows = await prisma.rateLimitHit.findMany({
    where: { key: { in: keys } },
    select: { key: true, count: true, windowStart: true }
  })
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const states: (WindowState | null)[] = keys.map((key) => {
    const row = byKey.get(key)
    return row ? { count: row.count, windowStartMs: row.windowStart.getTime() } : null
  })
  return decideRateLimit(states, scope.policy.tiers, now.getTime(), 1)
}

/**
 * Increment every tier of one scope and decide from the result.
 *
 * The increment is a single `INSERT … ON CONFLICT DO UPDATE`, which is the
 * whole point: read-then-write would let two concurrent attempts both see the
 * same stale count and both pass a budget that only had room for one. Postgres
 * resolves the conflict under a row lock, so the `count` this returns is the
 * true position of this attempt in the window even when a hundred arrive at
 * once — and because the decision is made from that returned value rather than
 * from a separate read, there is no gap to race.
 *
 * The window roll is inside the same statement for the same reason. Every
 * `CASE` compares the row's *existing* `windowStart` (SET expressions in
 * Postgres all read the pre-update row), so an expired window is reset to a
 * fresh window of one hit atomically, rather than by a read, a decision and a
 * write that another attempt can interleave with.
 */
async function bumpScope(scope: RateLimitScope, now: Date): Promise<RateLimitDecision> {
  const nowMs = now.getTime()

  const states = await prisma.$transaction(
    scope.policy.tiers.map((tier) => {
      const key = tierKey(scope.key, tier)
      const floor = new Date(nowMs - tier.windowMs)
      const expires = new Date(nowMs + tier.windowMs)
      return prisma.$queryRaw<Array<{ count: number; windowStart: Date }>>`
        INSERT INTO "RateLimitHit" ("key", "windowStart", "count", "expiresAt")
        VALUES (${key}, ${now}, 1, ${expires})
        ON CONFLICT ("key") DO UPDATE SET
          "count" = CASE
            WHEN "RateLimitHit"."windowStart" <= ${floor} THEN 1
            ELSE "RateLimitHit"."count" + 1
          END,
          "windowStart" = CASE
            WHEN "RateLimitHit"."windowStart" <= ${floor} THEN ${now}
            ELSE "RateLimitHit"."windowStart"
          END,
          "expiresAt" = CASE
            WHEN "RateLimitHit"."windowStart" <= ${floor} THEN ${expires}
            ELSE "RateLimitHit"."expiresAt"
          END
        RETURNING "count", "windowStart"
      `
    })
  )

  const observed: (WindowState | null)[] = states.map((rows) => {
    const row = rows[0]
    return row ? { count: Number(row.count), windowStartMs: row.windowStart.getTime() } : null
  })

  // `pending: 0` — the hit being judged is already inside these counts.
  return decideRateLimit(observed, scope.policy.tiers, nowMs, 0)
}

/** Would one more attempt fit every one of these counters? Reads only. */
export async function checkRateLimit(
  scopes: readonly RateLimitScope[],
  now: Date
): Promise<RateLimitDecision> {
  return failOpen('check', ALLOWED, async () =>
    combineDecisions(await Promise.all(scopes.map((scope) => peekScope(scope, now))))
  )
}

/** Count one attempt against every one of these counters, atomically. */
export async function recordRateLimitHit(
  scopes: readonly RateLimitScope[],
  now: Date
): Promise<RateLimitDecision> {
  return failOpen('record', ALLOWED, async () =>
    combineDecisions(await Promise.all(scopes.map((scope) => bumpScope(scope, now))))
  )
}

/**
 * Delete counters whose window is long over.
 *
 * Nothing else removes these rows, and one is created per throttled identifier
 * and per source, so without this the table grows for as long as the app runs —
 * and it grows fastest precisely when someone is attacking it, which is the
 * worst possible time to be adding unbounded rows to a database.
 *
 * `expiresAt` is the end of the row's own window, so a row past it can never
 * change a decision: `decideRateLimit` already treats a rolled window as empty,
 * which is why deleting one is invisible rather than a free budget reset.
 *
 * Called from the daily cron alongside `purgeDeadResetTokens`, deliberately
 * rather than from a second scheduled job. See the comment on that route: a
 * second cron entry is a second thing to configure, forget, and find
 * unconfigured a year later, and this is milliseconds of work once a day.
 */
export async function purgeExpiredRateLimitHits(now: Date): Promise<number> {
  const { count } = await prisma.rateLimitHit.deleteMany({
    where: { expiresAt: { lte: now } }
  })
  return count
}
