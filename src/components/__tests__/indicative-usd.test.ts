import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hasIndicativeUsdRate,
  indicativeUsdLine,
  indicativeUsdWhole
} from '@/components/indicative-usd'

/**
 * Two things are being tested here and the second one matters more.
 *
 * The formatting tests pin the wording and the arithmetic. The reachability
 * test pins the rule the whole module is built around: an approximate,
 * hand-maintained exchange rate must not be reachable from anything that
 * decides money. It is modelled on `domain/__tests__/domain-purity.test.ts`,
 * which enforces the mirror-image rule (the domain imports no I/O) the same
 * way — by reading the source rather than by trusting a comment.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

/**
 * Every tree where a figure can end up in a schedule, an allocation, an
 * invoice, an email or a database column.
 *
 * `src/app` is not a whole-tree root: it is mostly presentation, and the three
 * screens that render the line live in it. `src/components` is not here for the
 * same reason — it is where the module itself lives. But `src/app` is *also*
 * where every write path in this app lives, so it gets its own filtered sweep
 * below — see `WRITE_PATH`.
 */
const MONEY_ROOTS = ['src/domain', 'src/server', 'prisma']

/**
 * The write paths, which happen to live under `src/app` rather than under
 * `src/server`.
 *
 * This is the gap the roots above cannot close. `actions.ts` files are
 * `'use server'` modules — the sell flow's calls `createSale` — and `route.ts`
 * files are the HTTP handlers. Both decide money and both persist it, and in this
 * app both sit next to the screens in `src/app`. An import of an approximate,
 * hand-maintained exchange rate in either is exactly the failure this whole
 * module is arranged to prevent, so it is prohibited with the same strictness as
 * an import under `src/domain` — not merely recorded in the snapshot list at the
 * bottom of this file, whose message invites a reader to append a new call site.
 *
 * Deliberately by filename rather than by content: a file is a write path
 * because of where Next will run it, and `'use server'` can be added to an
 * `actions.ts` in the same diff that adds the bad import.
 */
const WRITE_PATH = /(?:^|[\\/])(?:actions|route)\.tsx?$/

/** Anything that would reach this module, by import or by re-export. */
const REFERENCE = /indicative-usd|indicativeUsd/

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      found.push(...sourceFilesUnder(full))
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      found.push(full)
    }
  }

  return found
}

describe('the indicative USD line', () => {
  it('renders whole dollars with grouping and says it is indicative', () => {
    // The mockup's figure, from the seeded 2-bedroom price: ₦145,000,000.
    expect(indicativeUsdLine(14_500_000_000n, 'NGN')).toBe('≈ USD 96,154 (indicative)')
  })

  it('rounds to the nearest dollar rather than truncating', () => {
    // 14,500,000,000 / 150,800 = 96,153.84…, so the honest nearest is 96,154 —
    // truncation would print 96,153.
    expect(indicativeUsdWhole(14_500_000_000n, 'NGN')).toBe(96_154n)
    // Exactly half a dollar rounds up.
    expect(indicativeUsdWhole(75_400n, 'NGN')).toBe(1n)
  })

  it('reads a zero-decimal currency at its own exponent', () => {
    // RWF has no minor unit, so 1,300,000 minor units is 1,300,000 francs —
    // treating it as two-decimal would be a 100x error.
    expect(indicativeUsdWhole(1_300_000n, 'RWF')).toBe(985n)
  })

  it('holds amounts far above Number.MAX_SAFE_INTEGER exactly', () => {
    // 90 quadrillion kobo. A float would have lost the low-order digits before
    // the division; the BigInt path does not.
    expect(indicativeUsdWhole(90_000_000_000_000_000n, 'NGN')).toBe(596_816_976_127n)
  })

  it('is case- and whitespace-tolerant about the code', () => {
    expect(indicativeUsdLine(12_900n, ' kes ')).toBe('≈ USD 1 (indicative)')
  })

  it('renders nothing for a currency with no rate', () => {
    // USD is deliberately absent: a dollar price needs no dollar equivalent.
    expect(indicativeUsdLine(14_500_000_000n, 'USD')).toBeNull()
    expect(hasIndicativeUsdRate('USD')).toBe(false)
    // And an unknown code is not a crash and not a zero.
    expect(indicativeUsdLine(14_500_000_000n, 'JPY')).toBeNull()
    expect(indicativeUsdWhole(14_500_000_000n, '')).toBeNull()
  })

  it('renders nothing rather than a negative estimate', () => {
    expect(indicativeUsdLine(-100n, 'NGN')).toBeNull()
  })

  it('renders zero as zero, not as nothing', () => {
    // A free unit is absurd, but a guard that swallowed 0 would also swallow a
    // genuine zero balance somewhere later.
    expect(indicativeUsdLine(0n, 'NGN')).toBe('≈ USD 0 (indicative)')
  })
})

describe('the indicative rate is unreachable from any money path', () => {
  it('has money paths to check', () => {
    for (const root of MONEY_ROOTS) {
      expect(
        sourceFilesUnder(path.join(REPO_ROOT, root)).length,
        `${root} should contain source files`
      ).toBeGreaterThan(0)
    }
  })

  it('is not imported anywhere under the domain, the server or the seed', () => {
    for (const root of MONEY_ROOTS) {
      for (const file of sourceFilesUnder(path.join(REPO_ROOT, root))) {
        const relative = path.relative(REPO_ROOT, file).replace(/\\/g, '/')
        // This test file names the module, and lives outside every money root —
        // if that ever stops being true the assertion below is the thing that
        // should be fixed, not this exemption widened.
        expect(
          REFERENCE.test(readFileSync(file, 'utf8')),
          `${relative} must not reach the indicative USD rate — it is approximate and no money path may read it`
        ).toBe(false)
      }
    }
  })

  it('has write paths under src/app to check', () => {
    // If a refactor moves the actions and routes elsewhere, this fails loudly
    // rather than letting the sweep below pass over an empty list.
    const writePaths = sourceFilesUnder(path.join(REPO_ROOT, 'src/app')).filter((file) =>
      WRITE_PATH.test(file)
    )
    expect(writePaths.length, 'src/app should contain actions.ts / route.ts files').toBeGreaterThan(
      0
    )
    // And the sell flow's server action specifically — the one that calls
    // `createSale`, and the reason this sweep exists.
    expect(
      writePaths
        .map((file) => path.relative(REPO_ROOT, file).replace(/\\/g, '/'))
        .includes('src/app/(staff)/(shell)/projects/[id]/sell/[unitId]/actions.ts')
    ).toBe(true)
  })

  it('is not imported by any server action or route handler under src/app', () => {
    // Prohibited, not recorded. These are the money writes.
    for (const file of sourceFilesUnder(path.join(REPO_ROOT, 'src/app'))) {
      if (!WRITE_PATH.test(file)) continue
      const relative = path.relative(REPO_ROOT, file).replace(/\\/g, '/')
      expect(
        REFERENCE.test(readFileSync(file, 'utf8')),
        `${relative} must not reach the indicative USD rate — it is approximate, and this file writes money`
      ).toBe(false)
    }
  })

  it('imports nothing itself, so it cannot pull the money core in either', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'src/components/indicative-usd.ts'), 'utf8')

    expect(src).not.toMatch(/(?:^|\n)\s*import\s/)
    expect(src).not.toMatch(/(?:from\s+|require\(\s*|import\(\s*)['"]/)
  })

  it('is drawn only by the three presentational screens that show a price', () => {
    // Not a cap on where it *could* go — a page or a layout under `src/app` is
    // allowed — but a record of where it does, so a fourth call site is a
    // deliberate decision rather than a diff nobody read. The write paths under
    // the same tree are *not* covered by this leniency: the test above prohibits
    // them outright, so a new entry here can only ever be another screen.
    const drawn = sourceFilesUnder(path.join(REPO_ROOT, 'src/app'))
      .filter((file) => REFERENCE.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(REPO_ROOT, file).replace(/\\/g, '/'))
      .sort()

    expect(drawn).toEqual([
      'src/app/(staff)/(shell)/projects/[id]/sell/[unitId]/confirm/page.tsx',
      'src/app/(staff)/(shell)/projects/[id]/sell/[unitId]/page.tsx',
      'src/app/(staff)/(shell)/projects/[id]/units/[unitId]/page.tsx'
    ])
  })
})
