import { describe, expect, it } from 'vitest'
import {
  branchKey,
  evaluateSeedGuard,
  hostOf,
  hostOrUrl,
  protectedBranchKey
} from '../../../prisma/seed-guard'

const PROD = 'postgresql://u:p@ep-little-block-axcqszs3.c-4.us-east-2.aws.neon.tech/neondb'
const PROD_POOLED =
  'postgresql://u:p@ep-little-block-axcqszs3-pooler.c-4.us-east-2.aws.neon.tech/neondb'
const DEV = 'postgresql://u:p@ep-dev-branch-99999999.c-4.us-east-2.aws.neon.tech/neondb'
const DEV_POOLED =
  'postgresql://u:p@ep-dev-branch-99999999-pooler.c-4.us-east-2.aws.neon.tech/neondb'

/**
 * What `.env` actually holds: DATABASE_URL is a URL, PROTECTED_DB_HOST is a
 * bare hostname. The first version of these tests passed a full URL for both,
 * so they agreed with a guard that could not read its own configuration —
 * every seed was refused for "PROTECTED_DB_HOST is not set" while it was set.
 */
const PROD_HOST = 'ep-little-block-axcqszs3.c-4.us-east-2.aws.neon.tech'

describe('hostOf / branchKey', () => {
  it('extracts the host and ignores the credentials', () => {
    expect(hostOf(PROD)).toBe('ep-little-block-axcqszs3.c-4.us-east-2.aws.neon.tech')
  })

  it('is strict for the target: a non-URL is unidentifiable, not a hostname', () => {
    // Leniency here would let a typo'd DATABASE_URL through as a "host" that
    // matches nothing — i.e. an unknown database judged safe to wipe.
    expect(hostOf(PROD_HOST)).toBe('')
    expect(hostOf('postgres-ish')).toBe('')
    expect(hostOf('not a url')).toBe('')
  })

  it('is lenient for the protected side, which is a bare hostname', () => {
    expect(hostOrUrl(PROD_HOST)).toBe(PROD_HOST)
    expect(hostOrUrl(PROD)).toBe(PROD_HOST)
    expect(protectedBranchKey(PROD_HOST)).toBe(branchKey(PROD))
  })

  it('still rejects junk on the protected side', () => {
    expect(hostOrUrl('not a host')).toBe('')
    expect(hostOrUrl('-leading-dash')).toBe('')
  })

  it('treats a pooled and a direct endpoint as the same branch', () => {
    expect(branchKey(PROD_POOLED)).toBe(branchKey(PROD))
    expect(branchKey(DEV_POOLED)).toBe(branchKey(DEV))
  })

  it('keeps different branches distinct', () => {
    expect(branchKey(DEV)).not.toBe(branchKey(PROD))
  })

  it('returns empty for an unparseable string rather than throwing', () => {
    expect(hostOf('not a url')).toBe('')
  })
})

describe('evaluateSeedGuard', () => {
  // Every case below configures PROTECTED_DB_HOST as a bare hostname, matching
  // the real .env, so these tests fail if the URL-vs-hostname bug returns.
  it('allows a development branch', () => {
    const out = evaluateSeedGuard({ DATABASE_URL: DEV, PROTECTED_DB_HOST: PROD_HOST })
    expect(out.allowed).toBe(true)
  })

  it('allows the dev branch through its pooled endpoint too', () => {
    const out = evaluateSeedGuard({ DATABASE_URL: DEV_POOLED, PROTECTED_DB_HOST: PROD_HOST })
    expect(out.allowed).toBe(true)
  })

  it('refuses the protected branch', () => {
    const out = evaluateSeedGuard({ DATABASE_URL: PROD, PROTECTED_DB_HOST: PROD_HOST })
    expect(out.allowed).toBe(false)
    expect(out.reason).toMatch(/protected database/i)
  })

  it('refuses the protected branch through its pooled endpoint', () => {
    // The likeliest real accident: .env holds the pooled URL, the guard is
    // configured with the direct host. A naive string compare would allow it.
    const out = evaluateSeedGuard({ DATABASE_URL: PROD_POOLED, PROTECTED_DB_HOST: PROD_HOST })
    expect(out.allowed).toBe(false)
  })

  it('still works when PROTECTED_DB_HOST is given as a full URL', () => {
    expect(evaluateSeedGuard({ DATABASE_URL: PROD, PROTECTED_DB_HOST: PROD }).allowed).toBe(false)
    expect(evaluateSeedGuard({ DATABASE_URL: DEV, PROTECTED_DB_HOST: PROD }).allowed).toBe(true)
  })

  it('refuses when PROTECTED_DB_HOST is unset — fails closed', () => {
    const out = evaluateSeedGuard({ DATABASE_URL: DEV })
    expect(out.allowed).toBe(false)
    expect(out.reason).toMatch(/PROTECTED_DB_HOST/)
  })

  it('refuses when DATABASE_URL is unset', () => {
    const out = evaluateSeedGuard({ PROTECTED_DB_HOST: PROD })
    expect(out.allowed).toBe(false)
  })

  it('refuses an unparseable DATABASE_URL', () => {
    const out = evaluateSeedGuard({ DATABASE_URL: 'postgres-ish', PROTECTED_DB_HOST: PROD })
    expect(out.allowed).toBe(false)
  })

  it('allows the protected branch only with the explicit override', () => {
    const out = evaluateSeedGuard({
      DATABASE_URL: PROD,
      PROTECTED_DB_HOST: PROD,
      SEED_ALLOW_PROTECTED: 'yes'
    })
    expect(out.allowed).toBe(true)
    expect(out.reason).toMatch(/deliberately/)
  })

  it('does not accept a truthy-but-wrong override value', () => {
    // 'true' / '1' are the values someone sets by habit; only 'yes' counts, so
    // the override cannot be tripped by a half-remembered convention.
    for (const value of ['true', '1', 'YES', 'y']) {
      const out = evaluateSeedGuard({
        DATABASE_URL: PROD,
        PROTECTED_DB_HOST: PROD,
        SEED_ALLOW_PROTECTED: value
      })
      expect(out.allowed, value).toBe(false)
    }
  })
})
