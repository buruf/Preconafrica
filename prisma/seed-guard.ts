/**
 * The seed's first act is to delete every row in every table. That is correct
 * for a development database and catastrophic for a production one, and the
 * only thing standing between the two is which connection string happens to be
 * in `.env` at the moment someone types `npm run db:seed`.
 *
 * This turns "be careful" into "cannot happen". The check is a hostname
 * comparison rather than a `NODE_ENV` test on purpose: `NODE_ENV` describes the
 * process, not the database it is pointed at, and the accident being prevented
 * here is precisely a development process pointed at production.
 */

/**
 * `tsx prisma/seed.ts` does not load `.env`, and Prisma only resolves its own
 * connection variable — so without this the guard would see no
 * PROTECTED_DB_HOST and refuse every seed, including legitimate ones. Failing
 * closed is right, but failing closed *always* is just a broken script.
 *
 * Node's built-in loader, so no dependency. Absent file is fine: CI and Vercel
 * supply real environment variables, and anything genuinely missing is caught
 * by the guard below rather than here.
 */
export function loadEnvFileIfPresent(): void {
  try {
    ;(process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile()
  } catch {
    // No .env, or a Node without loadEnvFile. Either way the guard decides.
  }
}

/**
 * Neon puts each branch on its own endpoint, so the host identifies the branch.
 *
 * Accepts either a full connection string or a bare hostname, because the two
 * inputs this guard compares are genuinely different shapes: DATABASE_URL is a
 * URL, while PROTECTED_DB_HOST is the host on its own. An earlier version ran
 * both through `new URL()`, which throws on a bare hostname and returned '' —
 * silently turning a configured guard into an unconfigured one.
 */
export function hostOf(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    return new URL(trimmed).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * The tolerant reading, for PROTECTED_DB_HOST only.
 *
 * The two sides of this comparison are deliberately held to different
 * standards. DATABASE_URL is always a connection string, so anything that
 * fails to parse as a URL is a target this guard cannot identify — and an
 * unidentifiable target must be refused, never guessed at. PROTECTED_DB_HOST
 * is a host on its own, so it has to accept one; being lenient there costs
 * nothing, because a wrong value can only ever fail to match, which refuses.
 */
export function hostOrUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const fromUrl = hostOf(trimmed)
  if (fromUrl) return fromUrl
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(trimmed) ? trimmed.toLowerCase() : ''
}

/**
 * A Neon pooled endpoint is the direct one with `-pooler` inserted into the
 * first label. Both belong to the same branch, so comparisons have to ignore it
 * or the pooled URL would read as a different database than the direct one.
 */
export function branchKey(connectionString: string): string {
  return hostOf(connectionString).replace('-pooler', '')
}

/** The same normalisation for the protected side, which may be a bare host. */
export function protectedBranchKey(value: string): string {
  return hostOrUrl(value).replace('-pooler', '')
}

export interface GuardOutcome {
  allowed: boolean
  reason: string
}

/**
 * Pure so it can be tested without a database or a process exit.
 *
 * `protectedHost` is the production branch's host, from PROTECTED_DB_HOST.
 * Absent, the guard fails **closed**: an unset variable is a misconfiguration,
 * and the safe reading of "I do not know which database this is" is to refuse,
 * not to proceed with a mass delete. Setting SEED_ALLOW_PROTECTED=yes is the
 * deliberate, visible override for the one case that genuinely needs it —
 * seeding production on purpose, once, at first launch.
 */
export function evaluateSeedGuard(env: {
  DATABASE_URL?: string
  PROTECTED_DB_HOST?: string
  SEED_ALLOW_PROTECTED?: string
}): GuardOutcome {
  const target = env.DATABASE_URL ?? ''
  if (!target) {
    return { allowed: false, reason: 'DATABASE_URL is not set — refusing to seed an unknown database.' }
  }

  const targetKey = branchKey(target)
  if (!targetKey) {
    return { allowed: false, reason: `DATABASE_URL is not a parseable URL — refusing to seed.` }
  }

  if (env.SEED_ALLOW_PROTECTED === 'yes') {
    return { allowed: true, reason: `SEED_ALLOW_PROTECTED=yes — seeding ${targetKey} deliberately.` }
  }

  const protectedKey = protectedBranchKey(env.PROTECTED_DB_HOST ?? '')
  if (!protectedKey) {
    return {
      allowed: false,
      reason:
        'PROTECTED_DB_HOST is not set, so this cannot tell development from production. ' +
        'Set it to the production branch host in .env. Refusing to seed.'
    }
  }

  if (targetKey === protectedKey) {
    return {
      allowed: false,
      reason:
        `DATABASE_URL points at the protected database (${targetKey}). ` +
        'The seed deletes every row before it writes any. Point DATABASE_URL at your ' +
        'development branch, or set SEED_ALLOW_PROTECTED=yes if you truly mean to wipe it.'
    }
  }

  return { allowed: true, reason: `Seeding ${targetKey}.` }
}

/** Throws — and so aborts the seed — unless the target is demonstrably safe. */
export function assertSeedTargetIsSafe(env: NodeJS.ProcessEnv = process.env): void {
  loadEnvFileIfPresent()
  const outcome = evaluateSeedGuard({
    DATABASE_URL: env.DATABASE_URL,
    PROTECTED_DB_HOST: env.PROTECTED_DB_HOST,
    SEED_ALLOW_PROTECTED: env.SEED_ALLOW_PROTECTED
  })

  if (!outcome.allowed) {
    throw new Error(`Seed refused.\n\n  ${outcome.reason}\n`)
  }
  console.log(outcome.reason)
}
