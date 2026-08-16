/**
 * The rate limiter's decision logic, with no storage and no clock.
 *
 * Everything here is a pure function of "what the counters said" and "what time
 * the caller says it is", which is the only way the interesting cases — a
 * window that has just rolled, two keys that must not interfere, a budget that
 * is exactly full — can be tested without a database and without sleeping.
 *
 * The shape is a fixed window per tier: a `windowStart`, a `count`, and a
 * budget. Fixed rather than sliding because the storage is one Postgres row per
 * key that has to be incremented atomically by a single statement; a sliding
 * log would need a row per attempt and a periodic sweep proportional to the
 * attack, which is exactly the thing an attacker gets to choose the size of.
 * The known cost of a fixed window is that an attacker who times a burst across
 * a boundary gets up to 2x the budget for one instant. Two tiers with different
 * window lengths bound that: the burst tier limits how fast, the hour tier
 * limits how much, and doubling the burst tier for one second still runs into
 * the hour tier.
 */

/** One budget: at most `limit` recorded hits inside any `windowMs` window. */
export interface RateLimitTier {
  /** Distinguishes this tier's row from the other tiers' rows for the same key. */
  readonly name: string
  readonly windowMs: number
  readonly limit: number
}

export interface RateLimitPolicy {
  /** Prefixes every key, so two policies can never share a counter. */
  readonly name: string
  readonly tiers: readonly RateLimitTier[]
}

/** A counter to consult: one policy, applied to one key. */
export interface RateLimitScope {
  readonly policy: RateLimitPolicy
  readonly key: string
}

/** What storage knows about one (key, tier) window. `null` means "no row". */
export interface WindowState {
  readonly count: number
  readonly windowStartMs: number
}

export interface RateLimitDecision {
  readonly allowed: boolean
  /** How long until the tightest exhausted tier frees up. 0 when allowed. */
  readonly retryAfterMs: number
}

export const ALLOWED: RateLimitDecision = { allowed: true, retryAfterMs: 0 }

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * Sign-in, counted per (account, source) pair rather than per account.
 *
 * Keying on the email alone would be a denial of service we built ourselves:
 * anyone who knows `admin@sunrise.test` could spend the budget from their own
 * machine and lock the real admin out of a system of record they need today.
 * Keying on the source alone would let one attacker walk a password list across
 * every account they can name at one attempt each. So both, in two independent
 * counters — this one, and SIGN_IN_SOURCE below.
 *
 * There is deliberately no global per-account tier. It is the one shape that
 * *does* hand an attacker a lockout button, and it buys little: an attacker
 * with enough distinct source addresses to slip under this tier is already past
 * anything a counter can do, and bcrypt at cost 10 is the actual wall.
 *
 * 5 a minute is roughly four honest typos and a retry; 20 an hour is a bad
 * afternoon for a real user and 0.5% of a small wordlist for an attacker.
 */
export const SIGN_IN: RateLimitPolicy = {
  name: 'signin',
  tiers: [
    { name: 'burst', windowMs: MINUTE, limit: 5 },
    { name: 'hour', windowMs: HOUR, limit: 20 }
  ]
}

/**
 * Sign-in, counted per source across every account it touches. This is the tier
 * that sees password spraying — one guess each against a hundred addresses —
 * which the per-account counter above cannot, because no single account ever
 * reaches its budget.
 *
 * Deliberately looser than the per-account tier by a factor of four, because a
 * source is not a person: an office, a school or a mobile carrier NAT can put
 * dozens of legitimate users behind one address, and this must not be the thing
 * that stops the fourth person in a sales office from signing in.
 */
export const SIGN_IN_SOURCE: RateLimitPolicy = {
  name: 'signin-src',
  tiers: [
    { name: 'burst', windowMs: MINUTE, limit: 20 },
    { name: 'hour', windowMs: HOUR, limit: 100 }
  ]
}

/**
 * Password-reset requests, per (address, source). Tighter than sign-in because
 * every accepted request costs real money and lands in a real person's inbox:
 * the failure mode is not a compromised account but a mail-bombed buyer and a
 * burned Resend quota. Three a minute is more than anyone needs — one link is
 * enough — and ten an hour is far past honest impatience.
 */
export const RESET_REQUEST: RateLimitPolicy = {
  name: 'reset-request',
  tiers: [
    { name: 'burst', windowMs: MINUTE, limit: 3 },
    { name: 'hour', windowMs: HOUR, limit: 10 }
  ]
}

/** Password-reset requests, per source across every address it names. */
export const RESET_REQUEST_SOURCE: RateLimitPolicy = {
  name: 'reset-request-src',
  tiers: [
    { name: 'burst', windowMs: MINUTE, limit: 10 },
    { name: 'hour', windowMs: HOUR, limit: 30 }
  ]
}

/**
 * Reset-link submissions, per source only.
 *
 * There is no per-identifier counter here on purpose. The identifier *is* the
 * token, and a counter keyed on the thing being guessed is not a counter at
 * all — every guess is a new key with a fresh budget, and the table grows one
 * row per attempt. The source is the only stable thing about a token guess.
 *
 * The token itself carries 256 bits of entropy, so this tier is not what makes
 * guessing infeasible; it is what stops someone turning /reset-password into a
 * free CPU sink of sha256 and bcrypt calls.
 */
export const RESET_SUBMIT_SOURCE: RateLimitPolicy = {
  name: 'reset-submit-src',
  tiers: [
    { name: 'burst', windowMs: MINUTE, limit: 10 },
    { name: 'hour', windowMs: HOUR, limit: 40 }
  ]
}

/**
 * Buyer registration in the staff sell flow, per (staff user, source). This one
 * is behind `requireStaff`, so it is not an anonymous attack surface — it is a
 * bound on how fast a compromised or scripted staff session can fill the User
 * table, and generous enough that an agent registering walk-ins all morning
 * never sees it.
 */
export const BUYER_REGISTRATION: RateLimitPolicy = {
  name: 'buyer-register',
  tiers: [
    { name: 'burst', windowMs: MINUTE, limit: 10 },
    { name: 'hour', windowMs: HOUR, limit: 60 }
  ]
}

/**
 * The one sentence every throttled surface shows.
 *
 * A plain instruction, not a status code and not a number the user has to
 * interpret. It is also identical on every surface and for every input, which
 * is load-bearing on the login page: a message that appeared only for
 * registered addresses would undo the enumeration resistance the rest of that
 * flow is built around. The counters it is derived from are keyed on what was
 * typed and where from, never on whether the account exists, so a real address
 * and a made-up one reach this sentence after exactly the same number of tries.
 */
export const RATE_LIMIT_MESSAGE =
  'Too many attempts. Please wait a minute and try again.'

/** Identifiers are compared case-insensitively and bounded, since they key a row. */
function normalise(value: string): string {
  return value.trim().toLowerCase().slice(0, 160)
}

/**
 * The key for a counter scoped to one identifier *as seen from one source*.
 * Both halves are in the key, which is what makes an attacker's attempts
 * against someone else's address land in the attacker's own bucket.
 */
export function identifierKey(
  policy: RateLimitPolicy,
  identifier: string,
  source: string
): string {
  return `${policy.name}:id:${normalise(identifier)}|${normalise(source)}`
}

/** The key for a counter scoped to a source across every identifier it names. */
export function sourceKey(policy: RateLimitPolicy, source: string): string {
  return `${policy.name}:src:${normalise(source)}`
}

/** One row per (key, tier) — the tiers of a key must not share a counter. */
export function tierKey(key: string, tier: RateLimitTier): string {
  return `${key}#${tier.name}`
}

/**
 * The client address, from Vercel's `x-forwarded-for`.
 *
 * Only the first entry is trusted. The header is a comma-separated chain and
 * anything after the first hop is whatever the previous proxy claimed; on
 * Vercel the first entry is the one the platform wrote. It is still spoofable
 * in principle by a client that sets the header before it reaches the edge, so
 * this is a speed bump and not an identity — which is exactly why the
 * per-account tier above is keyed on the address *in addition to* the account
 * rather than instead of it, and why nothing here is used for authorisation.
 *
 * An absent or empty header collapses to one shared 'unknown' bucket. That is
 * deliberate: it means a request with no discoverable source is throttled
 * alongside every other such request rather than escaping the limiter, and the
 * per-account tier still separates them by address.
 */
export const UNKNOWN_SOURCE = 'unknown'

export function clientIpFromForwardedFor(header: string | null | undefined): string {
  const first = (header ?? '').split(',')[0]?.trim() ?? ''
  return first === '' ? UNKNOWN_SOURCE : first
}

/**
 * Sign-in: the account as seen from this source, and the source itself.
 *
 * The email is used only as a counter key. It is never looked up, so this
 * function behaves identically for a registered address and a made-up one —
 * which is what lets the login page show a throttle message without turning it
 * into an account-existence oracle.
 *
 * The scope builders live here, beside the policies and the key format, rather
 * than next to the storage: choosing which counters a surface is measured by is
 * a decision, not I/O, and keeping it pure is what lets a caller's tests use the
 * real keys while faking only the database round trip.
 */
export function signInScopes(email: string, source: string): RateLimitScope[] {
  return [
    { policy: SIGN_IN, key: identifierKey(SIGN_IN, email, source) },
    { policy: SIGN_IN_SOURCE, key: sourceKey(SIGN_IN_SOURCE, source) }
  ]
}

/** Password-reset requests: the address as seen from this source, and the source. */
export function resetRequestScopes(email: string, source: string): RateLimitScope[] {
  return [
    { policy: RESET_REQUEST, key: identifierKey(RESET_REQUEST, email, source) },
    { policy: RESET_REQUEST_SOURCE, key: sourceKey(RESET_REQUEST_SOURCE, source) }
  ]
}

/** Reset-link submissions: source only. See RESET_SUBMIT_SOURCE for why. */
export function resetSubmitScopes(source: string): RateLimitScope[] {
  return [{ policy: RESET_SUBMIT_SOURCE, key: sourceKey(RESET_SUBMIT_SOURCE, source) }]
}

/** Buyer registration in the sell flow: the acting staff user, from this source. */
export function buyerRegistrationScopes(userId: string, source: string): RateLimitScope[] {
  return [
    { policy: BUYER_REGISTRATION, key: identifierKey(BUYER_REGISTRATION, userId, source) }
  ]
}

/** A window that has rolled past its length counts as empty. */
function effectiveCount(
  state: WindowState | null | undefined,
  tier: RateLimitTier,
  nowMs: number
): number {
  if (!state) return 0
  if (nowMs - state.windowStartMs >= tier.windowMs) return 0
  return state.count
}

/**
 * Decide whether an attempt fits the budget.
 *
 * `states[i]` is what storage holds for `tiers[i]`; a missing entry is an empty
 * window. `pending` is 1 when asking "would one more hit fit?" (a check taken
 * before the work, where nothing has been counted yet) and 0 when `states`
 * already includes the attempt being judged (a decision taken from the result
 * of the increment itself). Both callers exist and getting them confused is an
 * off-by-one in a security control, so the parameter is explicit rather than
 * inferred.
 */
export function decideRateLimit(
  states: ReadonlyArray<WindowState | null | undefined>,
  tiers: readonly RateLimitTier[],
  nowMs: number,
  pending: 0 | 1
): RateLimitDecision {
  let retryAfterMs = 0

  for (let i = 0; i < tiers.length; i += 1) {
    const tier = tiers[i]
    const state = states[i]
    const count = effectiveCount(state, tier, nowMs) + pending
    if (count <= tier.limit) continue

    // Blocked by this tier. It frees up when its window rolls; `state` is
    // necessarily non-null here, because an empty window cannot exceed a
    // limit of at least one.
    const freeAt = (state?.windowStartMs ?? nowMs) + tier.windowMs
    retryAfterMs = Math.max(retryAfterMs, Math.max(0, freeAt - nowMs))
  }

  return retryAfterMs > 0 ? { allowed: false, retryAfterMs } : ALLOWED
}

/** Combine the decisions of several independent counters: all must allow. */
export function combineDecisions(
  decisions: readonly RateLimitDecision[]
): RateLimitDecision {
  let retryAfterMs = 0
  for (const decision of decisions) {
    if (!decision.allowed) retryAfterMs = Math.max(retryAfterMs, decision.retryAfterMs)
  }
  return retryAfterMs > 0 ? { allowed: false, retryAfterMs } : ALLOWED
}
