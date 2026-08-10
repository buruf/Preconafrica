# Preconstruction Unit Sales Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A multi-tenant mobile-first website where African property developers sell preconstruction units on installment plans, record payments manually, issue PDF documents, and email due/overdue reminders automatically.

**Architecture:** A layered monolith with a pure domain core. `src/domain/` holds all money math, date math, schedule generation, allocation and status derivation as pure functions that import nothing from Prisma or the server layer — this is what makes them testable in milliseconds without a database. `src/server/` wraps them in Prisma repositories and services. `src/app/` renders Server Components and mutates through Server Actions, so buyers on weak connections receive HTML rather than a JS bundle that then fetches JSON.

**Tech Stack:** Next.js 14 (App Router), TypeScript (strict), Prisma + Neon Postgres, Auth.js v5 credentials + bcryptjs, Tailwind CSS, Zod, Resend, `@react-pdf/renderer`, Vitest, Vercel Cron.

## Global Constraints

Every task's requirements implicitly include this section.

- **Money is never a float.** All monetary values are `BigInt` minor units (kobo, cents), stored in Postgres `int8` via Prisma `BigInt`. A ₦250,000,000 unit is 25,000,000,000 kobo, which overflows `Int32`. No `number`, no `parseFloat`, no `toFixed` anywhere in a money path.
- **`src/domain/**` must not import Prisma, `src/server/**`, `next`, or any I/O.** This is enforced by test `domain-purity.test.ts` in Task 2. Domain functions never read the clock — `asOf` / `signedAt` are always parameters.
- **No hardcoded USD.** Currency comes from `Project.currency` (ISO-4217). USD is one row in the currency table, never a default or fallback.
- **Currency exponents:** `NGN, KES, GHS, ZAR, EGP, MAD, TZS = 2` and `RWF, UGX, XOF, XAF, DJF = 0`, plus `USD, EUR, GBP = 2`.
- **Installment status is derived, never stored.** Only `amountPaidMinor` and `paidAt` are persisted.
- **Rounding rule:** monthly amount is floor division; the **final** installment absorbs the entire remainder.
- **Due-date rule:** monthly anniversary of the signing date, day-of-month clamped to the last valid day of short months, always recomputed from the signing date (never iteratively) so Jan 31 → Feb 28 → **Mar 31**.
- **Allocation rule:** oldest unpaid entry first, excess cascades forward, surplus returned explicitly as `overpaymentMinor`.
- **All dates are UTC.** Use `Date.UTC(...)` and `getUTC*`. Never local-time getters.
- **Every query is scoped by `orgId` taken from the session**, never from a route parameter or form field.
- **`CRON_SECRET` is fail-closed:** absent secret returns 401, never "allow".
- **Default term is 36 months**; `reminderDaysBefore` default 7; `overdueNoticeDaysAfter` default 3.
- **Mobile-first.** Tailwind base styles target ~360px; no primary view does client-side data fetching.
- Commit after every task. Conventional commit messages.

---

## File Structure

```
prisma/schema.prisma            all models + enums
prisma/seed.ts                  two orgs-worth of demo data in NGN and KES

src/domain/currency.ts          exponent table, parse/format, no I/O
src/domain/dates.ts             startOfUtcDay, addMonthsClamped, differenceInDaysUtc
src/domain/schedule.ts          generateSchedule + ScheduleError
src/domain/allocation.ts        allocatePayment
src/domain/status.ts            deriveStatus, daysLate
src/domain/units.ts             columnLetters, generateUnitNames

src/server/db.ts                Prisma singleton
src/server/auth.ts              Auth.js v5 config
src/server/session.ts           requireUser / requireRole / requireBuyer
src/server/services/projects.ts createProject (generates units in one tx)
src/server/services/units.ts    inventory query, renameUnit, reserveUnit (conditional update)
src/server/services/sales.ts    registerBuyer, previewSchedule, createSale
src/server/services/payments.ts recordPayment, voidPayment
src/server/services/arrears.ts  arrearsReport
src/server/services/documents.ts issueDocument + per-org numbering
src/server/pdf/*.tsx            invoice, receipt, statement documents + render
src/server/notifications/sender.ts   channel-agnostic interface + registry
src/server/notifications/resend.ts   EMAIL adapter
src/server/notifications/templates.ts
src/server/notifications/dispatch.ts sendForEntry with NotificationLog idempotency

src/app/(auth)/login, /register
src/app/(staff)/projects, /projects/[id], /sales/[id], /arrears
src/app/(buyer)/dashboard
src/app/buy/[projectId]                 buyer purchase flow
src/app/api/cron/reminders/route.ts
src/app/api/documents/[id]/route.ts
vercel.json                     cron schedule
```

---

### Task 1: Scaffold, tooling, and a proving test

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.mjs`, `tailwind.config.ts`, `postcss.config.mjs`, `vitest.config.ts`, `.env.example`, `.gitignore`, `src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx`
- Test: `src/domain/__tests__/harness.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm test` (Vitest) and `npm run build` (Next.js) for every later task.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "preconstruction",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "prisma generate && next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "db:push": "prisma db push",
    "db:seed": "tsx prisma/seed.ts"
  },
  "prisma": { "seed": "tsx prisma/seed.ts" },
  "dependencies": {
    "@prisma/client": "^5.18.0",
    "@react-pdf/renderer": "^3.4.4",
    "bcryptjs": "^2.4.3",
    "next": "14.2.5",
    "next-auth": "5.0.0-beta.20",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "resend": "^3.4.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/node": "^20.14.0",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "autoprefixer": "^10.4.19",
    "postcss": "^8.4.40",
    "prisma": "^5.18.0",
    "tailwindcss": "^3.4.7",
    "tsx": "^4.16.2",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`target: ES2022` is required — `BigInt` literals (`0n`) are a syntax error below ES2020.

- [ ] **Step 3: Create the remaining config files**

`next.config.mjs`:
```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@react-pdf/renderer', '@prisma/client', 'bcryptjs']
  }
}
export default nextConfig
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') }
  }
})
```

`tailwind.config.ts`:
```ts
import type { Config } from 'tailwindcss'

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: []
} satisfies Config
```

`postcss.config.mjs`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } }
```

`.gitignore`:
```
node_modules
.next
.env
.env*.local
*.tsbuildinfo
next-env.d.ts
```

`.env.example`:
```
DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"
NEXTAUTH_SECRET=""
NEXTAUTH_URL="http://localhost:3000"
RESEND_API_KEY=""
EMAIL_FROM="Sunrise Developments <noreply@example.com>"
CRON_SECRET=""
```

- [ ] **Step 4: Create the minimal app shell**

`src/app/globals.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html { -webkit-text-size-adjust: 100%; }
body { @apply bg-slate-50 text-slate-900 antialiased; }
```

`src/app/layout.tsx`:
```tsx
import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = { title: 'Preconstruction Sales' }
export const viewport: Viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  )
}
```

`src/app/page.tsx`:
```tsx
export default function Home() {
  return <main className="p-6"><h1 className="text-xl font-semibold">Preconstruction Sales</h1></main>
}
```

- [ ] **Step 5: Write the harness test**

`src/domain/__tests__/harness.test.ts`:
```ts
import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('runs and supports BigInt literals', () => {
    expect(25_000_000_000n + 1n).toBe(25_000_000_001n)
  })
})
```

- [ ] **Step 6: Install and run**

```bash
npm install
npm test
```
Expected: `1 passed`. If BigInt literals error, `tsconfig.json` target is wrong.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js 14 + Prisma + Vitest toolchain"
```

---

### Task 2: Currency module and the domain-purity guard

**Files:**
- Create: `src/domain/currency.ts`
- Test: `src/domain/__tests__/currency.test.ts`, `src/domain/__tests__/domain-purity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SUPPORTED_CURRENCIES: Readonly<Record<string, number>>`
  - `exponentFor(code: string): number` — throws `UnsupportedCurrencyError` on unknown code
  - `isSupportedCurrency(code: string): boolean`
  - `toMinor(major: string, code: string): bigint`
  - `formatMinor(amountMinor: bigint, code: string, locale?: string): string`
  - `class UnsupportedCurrencyError extends Error`

- [ ] **Step 1: Write the failing tests**

`src/domain/__tests__/currency.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  UnsupportedCurrencyError,
  exponentFor,
  formatMinor,
  isSupportedCurrency,
  toMinor
} from '@/domain/currency'

describe('exponentFor', () => {
  it('returns 2 for two-decimal African currencies', () => {
    for (const code of ['NGN', 'KES', 'GHS', 'ZAR', 'EGP', 'MAD', 'TZS']) {
      expect(exponentFor(code)).toBe(2)
    }
  })

  it('returns 0 for zero-decimal African currencies', () => {
    for (const code of ['RWF', 'UGX', 'XOF', 'XAF', 'DJF']) {
      expect(exponentFor(code)).toBe(0)
    }
  })

  it('treats USD as an ordinary entry, not a default', () => {
    expect(exponentFor('USD')).toBe(2)
    expect(isSupportedCurrency('ZZZ')).toBe(false)
    expect(() => exponentFor('ZZZ')).toThrow(UnsupportedCurrencyError)
  })

  it('is case-insensitive', () => {
    expect(exponentFor('ngn')).toBe(2)
  })
})

describe('toMinor', () => {
  it('converts a two-decimal amount', () => {
    expect(toMinor('1250.75', 'NGN')).toBe(125075n)
  })

  it('pads a missing fractional part', () => {
    expect(toMinor('1250.5', 'NGN')).toBe(125050n)
    expect(toMinor('1250', 'NGN')).toBe(125000n)
  })

  it('handles a zero-decimal currency with no scaling', () => {
    expect(toMinor('1250', 'RWF')).toBe(1250n)
  })

  it('handles amounts far beyond Int32', () => {
    expect(toMinor('250000000', 'NGN')).toBe(25_000_000_000n)
  })

  it('strips thousands separators and whitespace', () => {
    expect(toMinor(' 250,000,000.00 ', 'NGN')).toBe(25_000_000_000n)
  })

  it('rejects more fractional digits than the currency allows', () => {
    expect(() => toMinor('10.999', 'NGN')).toThrow(/fractional/i)
    expect(() => toMinor('10.5', 'RWF')).toThrow(/fractional/i)
  })

  it('rejects non-numeric input', () => {
    expect(() => toMinor('abc', 'NGN')).toThrow(/invalid/i)
  })
})

describe('formatMinor', () => {
  it('formats a two-decimal currency with its symbol', () => {
    const out = formatMinor(25_000_000_000n, 'NGN', 'en-NG')
    expect(out).toContain('250,000,000')
    expect(out).toMatch(/NGN|₦/)
  })

  it('formats a zero-decimal currency without decimals', () => {
    const out = formatMinor(1250n, 'RWF', 'en-RW')
    expect(out).toContain('1,250')
    expect(out).not.toContain('.00')
  })

  it('formats negative amounts', () => {
    expect(formatMinor(-125075n, 'NGN', 'en-NG')).toContain('1,250.75')
  })
})
```

`src/domain/__tests__/domain-purity.test.ts`:
```ts
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DOMAIN_DIR = path.resolve(__dirname, '..')
const FORBIDDEN = [
  '@prisma/client',
  '@/server',
  'next/',
  'node:fs',
  'resend'
]

function domainSourceFiles(): string[] {
  return readdirSync(DOMAIN_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(DOMAIN_DIR, f))
}

describe('domain purity', () => {
  it('has domain source files to check', () => {
    expect(domainSourceFiles().length).toBeGreaterThan(0)
  })

  it('imports no I/O or persistence modules', () => {
    for (const file of domainSourceFiles()) {
      const src = readFileSync(file, 'utf8')
      for (const forbidden of FORBIDDEN) {
        expect(src, `${path.basename(file)} must not import ${forbidden}`)
          .not.toContain(`from '${forbidden}`)
      }
    }
  })

  it('never reads the clock', () => {
    for (const file of domainSourceFiles()) {
      const src = readFileSync(file, 'utf8')
      expect(src, `${path.basename(file)} must not call Date.now()`).not.toContain('Date.now(')
      expect(src, `${path.basename(file)} must not call new Date()`).not.toMatch(/new Date\(\s*\)/)
    }
  })
})
```

This purity test is the enforcement mechanism for the architecture's central rule. It runs against every file added to `src/domain/` in Tasks 3–7 automatically.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- currency
```
Expected: FAIL, `Cannot find module '@/domain/currency'`.

- [ ] **Step 3: Implement `src/domain/currency.ts`**

```ts
export class UnsupportedCurrencyError extends Error {
  constructor(code: string) {
    super(`Unsupported currency code: ${code}`)
    this.name = 'UnsupportedCurrencyError'
  }
}

/**
 * ISO-4217 minor-unit exponents. Not every currency has two decimals —
 * RWF, UGX, XOF, XAF and DJF have none, and assuming 2 would inflate every
 * amount in those markets by 100x. USD is one row here, never a fallback.
 */
export const SUPPORTED_CURRENCIES: Readonly<Record<string, number>> = Object.freeze({
  NGN: 2, KES: 2, GHS: 2, ZAR: 2, EGP: 2, MAD: 2, TZS: 2,
  RWF: 0, UGX: 0, XOF: 0, XAF: 0, DJF: 0,
  USD: 2, EUR: 2, GBP: 2
})

function normalize(code: string): string {
  return code.trim().toUpperCase()
}

export function isSupportedCurrency(code: string): boolean {
  return normalize(code) in SUPPORTED_CURRENCIES
}

export function exponentFor(code: string): number {
  const key = normalize(code)
  const exponent = SUPPORTED_CURRENCIES[key]
  if (exponent === undefined) throw new UnsupportedCurrencyError(code)
  return exponent
}

/**
 * Parses a human-entered major-unit string into exact minor units.
 * String input, not number — a float cannot represent 250000000.10 exactly.
 */
export function toMinor(major: string, code: string): bigint {
  const exponent = exponentFor(code)
  const cleaned = major.replace(/[\s,_]/g, '')
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(cleaned)
  if (!match) throw new Error(`Invalid amount: ${major}`)

  const [, sign, whole, fraction = ''] = match
  if (fraction.length > exponent) {
    throw new Error(
      `Amount ${major} has ${fraction.length} fractional digits but ${normalize(code)} allows ${exponent}`
    )
  }

  const padded = fraction.padEnd(exponent, '0')
  const magnitude = BigInt(whole + padded)
  return sign === '-' ? -magnitude : magnitude
}

export function formatMinor(amountMinor: bigint, code: string, locale = 'en-US'): string {
  const currency = normalize(code)
  const exponent = exponentFor(currency)
  const negative = amountMinor < 0n
  const magnitude = negative ? -amountMinor : amountMinor

  const divisor = 10n ** BigInt(exponent)
  const whole = magnitude / divisor
  const fraction = magnitude % divisor

  const numeric =
    exponent === 0
      ? whole.toString()
      : `${whole}.${fraction.toString().padStart(exponent, '0')}`

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent
  }).format(Number(negative ? `-${numeric}` : numeric))
}
```

`formatMinor` converts to `Number` only at the final display step, after exact BigInt arithmetic has produced the digits — no precision is lost in any calculation.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- currency
npm test -- domain-purity
```
Expected: PASS for both.

- [ ] **Step 5: Commit**

```bash
git add src/domain
git commit -m "feat(domain): currency exponent table, exact minor-unit parsing, purity guard"
```

---

### Task 3: UTC date arithmetic with month-end clamping

**Files:**
- Create: `src/domain/dates.ts`
- Test: `src/domain/__tests__/dates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `startOfUtcDay(d: Date): Date`
  - `addMonthsClamped(start: Date, months: number): Date`
  - `differenceInDaysUtc(later: Date, earlier: Date): number`

- [ ] **Step 1: Write the failing tests**

`src/domain/__tests__/dates.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { addMonthsClamped, differenceInDaysUtc, startOfUtcDay } from '@/domain/dates'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
const iso = (d: Date) => d.toISOString().slice(0, 10)

describe('startOfUtcDay', () => {
  it('zeroes the time component in UTC', () => {
    const result = startOfUtcDay(new Date('2026-03-15T23:47:11.512Z'))
    expect(result.toISOString()).toBe('2026-03-15T00:00:00.000Z')
  })
})

describe('addMonthsClamped', () => {
  it('adds whole months on a safe day-of-month', () => {
    expect(iso(addMonthsClamped(utc(2026, 1, 15), 1))).toBe('2026-02-15')
    expect(iso(addMonthsClamped(utc(2026, 1, 15), 12))).toBe('2027-01-15')
  })

  it('clamps Jan 31 to Feb 28 in a common year', () => {
    expect(iso(addMonthsClamped(utc(2026, 1, 31), 1))).toBe('2026-02-28')
  })

  it('clamps Jan 31 to Feb 29 in a leap year', () => {
    expect(iso(addMonthsClamped(utc(2028, 1, 31), 1))).toBe('2028-02-29')
  })

  it('restores the original day after a clamped month', () => {
    // The regression this guards: iterating month-by-month would give Mar 28.
    const signed = utc(2026, 1, 31)
    expect(iso(addMonthsClamped(signed, 1))).toBe('2026-02-28')
    expect(iso(addMonthsClamped(signed, 2))).toBe('2026-03-31')
    expect(iso(addMonthsClamped(signed, 3))).toBe('2026-04-30')
    expect(iso(addMonthsClamped(signed, 4))).toBe('2026-05-31')
  })

  it('never rolls forward into the following month', () => {
    for (let m = 1; m <= 36; m++) {
      const result = addMonthsClamped(utc(2026, 1, 31), m)
      const expectedMonth = (0 + m) % 12
      expect(result.getUTCMonth()).toBe(expectedMonth)
    }
  })

  it('crosses year boundaries across a 36-month term', () => {
    expect(iso(addMonthsClamped(utc(2026, 8, 9), 36))).toBe('2029-08-09')
  })

  it('handles month 0 as the start date itself', () => {
    expect(iso(addMonthsClamped(utc(2026, 8, 9), 0))).toBe('2026-08-09')
  })

  it('normalises the time component to UTC midnight', () => {
    const result = addMonthsClamped(new Date('2026-01-31T18:30:00.000Z'), 1)
    expect(result.toISOString()).toBe('2026-02-28T00:00:00.000Z')
  })
})

describe('differenceInDaysUtc', () => {
  it('counts whole days between dates', () => {
    expect(differenceInDaysUtc(utc(2026, 8, 9), utc(2026, 8, 2))).toBe(7)
  })

  it('returns 0 for the same day regardless of time', () => {
    expect(
      differenceInDaysUtc(new Date('2026-08-09T23:00:00Z'), new Date('2026-08-09T01:00:00Z'))
    ).toBe(0)
  })

  it('returns a negative count when the first date is earlier', () => {
    expect(differenceInDaysUtc(utc(2026, 8, 2), utc(2026, 8, 9))).toBe(-7)
  })

  it('is unaffected by daylight-saving transitions', () => {
    expect(differenceInDaysUtc(utc(2026, 4, 1), utc(2026, 3, 1))).toBe(31)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- dates
```
Expected: FAIL, `Cannot find module '@/domain/dates'`.

- [ ] **Step 3: Implement `src/domain/dates.ts`**

```ts
const MS_PER_DAY = 86_400_000

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * Adds whole months, clamping the day-of-month to the last valid day of the
 * target month.
 *
 * Always computed from `start`, never iteratively: iterating Jan 31 forward one
 * month at a time gives Feb 28 then Mar 28, permanently degrading the buyer's
 * due date. Recomputing from the signing date each time gives Mar 31, which is
 * what a contract means by "the 31st of each month".
 */
export function addMonthsClamped(start: Date, months: number): Date {
  if (!Number.isInteger(months)) {
    throw new RangeError(`months must be an integer, received ${months}`)
  }

  const originalDay = start.getUTCDate()
  const targetMonthStart = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1)
  )

  // Day 0 of the following month is the last day of the target month.
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetMonthStart.getUTCFullYear(), targetMonthStart.getUTCMonth() + 1, 0)
  ).getUTCDate()

  return new Date(
    Date.UTC(
      targetMonthStart.getUTCFullYear(),
      targetMonthStart.getUTCMonth(),
      Math.min(originalDay, lastDayOfTargetMonth)
    )
  )
}

export function differenceInDaysUtc(later: Date, earlier: Date): number {
  return Math.round(
    (startOfUtcDay(later).getTime() - startOfUtcDay(earlier).getTime()) / MS_PER_DAY
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- dates
```
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/dates.ts src/domain/__tests__/dates.test.ts
git commit -m "feat(domain): UTC month arithmetic with non-degrading month-end clamping"
```

---

### Task 4: Schedule generation and amortization

This is the core of the system. Everything else is plumbing around it.

**Files:**
- Create: `src/domain/schedule.ts`
- Test: `src/domain/__tests__/schedule.test.ts`

**Interfaces:**
- Consumes: `addMonthsClamped`, `startOfUtcDay` from `@/domain/dates`.
- Produces:
  - `type PlanType = 'FULL' | 'INSTALLMENTS'`
  - `interface ScheduleEntryDraft { sequence: number; dueDate: Date; amountDueMinor: bigint }`
  - `interface ScheduleInput { planType: PlanType; priceMinor: bigint; depositMinor: bigint; months: number; signedAt: Date }`
  - `generateSchedule(input: ScheduleInput): ScheduleEntryDraft[]`
  - `totalScheduledMinor(entries: ScheduleEntryDraft[]): bigint`
  - `class ScheduleError extends Error`
  - `const DEFAULT_TERM_MONTHS = 36`

**Note on currency:** `generateSchedule` takes no currency parameter. Amounts are already `BigInt` minor units, so `financed / months` in BigInt *is* floor division at the currency's smallest unit — the exponent is irrelevant here and only matters for parsing and display. Adding a currency parameter would be unused ceremony.

- [ ] **Step 1: Write the failing tests**

`src/domain/__tests__/schedule.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERM_MONTHS,
  ScheduleError,
  generateSchedule,
  totalScheduledMinor
} from '@/domain/schedule'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
const iso = (d: Date) => d.toISOString().slice(0, 10)

const installments = (over: Partial<Parameters<typeof generateSchedule>[0]> = {}) =>
  generateSchedule({
    planType: 'INSTALLMENTS',
    priceMinor: 3_600_000n,
    depositMinor: 0n,
    months: 36,
    signedAt: utc(2026, 8, 9),
    ...over
  })

describe('generateSchedule — full payment', () => {
  it('produces exactly one entry due on the signing date', () => {
    const entries = generateSchedule({
      planType: 'FULL',
      priceMinor: 25_000_000_000n,
      depositMinor: 0n,
      months: 0,
      signedAt: utc(2026, 8, 9)
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].sequence).toBe(1)
    expect(entries[0].amountDueMinor).toBe(25_000_000_000n)
    expect(iso(entries[0].dueDate)).toBe('2026-08-09')
  })

  it('rejects a deposit on a full-payment sale', () => {
    expect(() =>
      generateSchedule({
        planType: 'FULL',
        priceMinor: 1000n,
        depositMinor: 100n,
        months: 0,
        signedAt: utc(2026, 8, 9)
      })
    ).toThrow(ScheduleError)
  })
})

describe('generateSchedule — even division', () => {
  it('produces identical installments when the amount divides evenly', () => {
    const entries = installments({ priceMinor: 3_600_000n, months: 36 })
    expect(entries).toHaveLength(36)
    for (const entry of entries) {
      expect(entry.amountDueMinor).toBe(100_000n)
    }
  })

  it('numbers entries from 1 without gaps', () => {
    const entries = installments()
    expect(entries.map((e) => e.sequence)).toEqual(
      Array.from({ length: 36 }, (_, i) => i + 1)
    )
  })

  it('defaults to a 36-month term constant', () => {
    expect(DEFAULT_TERM_MONTHS).toBe(36)
  })
})

describe('generateSchedule — remainder handling', () => {
  it('puts the entire remainder on the final installment', () => {
    // 100000 financed over 36 = 2777.77…; floor 2777, remainder 28
    const entries = installments({ priceMinor: 100_000n, months: 36 })

    for (const entry of entries.slice(0, 35)) {
      expect(entry.amountDueMinor).toBe(2_777n)
    }
    expect(entries[35].amountDueMinor).toBe(100_000n - 2_777n * 35n)
    expect(entries[35].amountDueMinor).toBe(2_805n)
  })

  it('subtracts the deposit before amortizing', () => {
    const entries = installments({
      priceMinor: 5_000_000n,
      depositMinor: 1_400_000n,
      months: 36
    })
    expect(totalScheduledMinor(entries)).toBe(3_600_000n)
    expect(entries[0].amountDueMinor).toBe(100_000n)
  })

  it('handles a term of exactly one month', () => {
    const entries = installments({ priceMinor: 999n, depositMinor: 99n, months: 1 })
    expect(entries).toHaveLength(1)
    expect(entries[0].amountDueMinor).toBe(900n)
  })

  it('handles a financed amount smaller than the term length', () => {
    // 10 minor units over 36 months: base floor is 0, last entry takes all 10.
    const entries = installments({ priceMinor: 10n, months: 36 })
    expect(entries.slice(0, 35).every((e) => e.amountDueMinor === 0n)).toBe(true)
    expect(entries[35].amountDueMinor).toBe(10n)
    expect(totalScheduledMinor(entries)).toBe(10n)
  })
})

describe('generateSchedule — the invariant', () => {
  it('always sums to exactly price minus deposit', () => {
    const prices = [100_000n, 3_600_001n, 25_000_000_000n, 999_999_999n, 7n, 1_250n]
    const deposits = [0n, 1n, 1_000n, 500_000n]
    const terms = [1, 2, 6, 12, 24, 36, 60, 120]

    for (const priceMinor of prices) {
      for (const depositMinor of deposits) {
        if (depositMinor >= priceMinor) continue
        for (const months of terms) {
          const entries = generateSchedule({
            planType: 'INSTALLMENTS',
            priceMinor,
            depositMinor,
            months,
            signedAt: utc(2026, 1, 31)
          })
          expect(
            totalScheduledMinor(entries),
            `price=${priceMinor} deposit=${depositMinor} months=${months}`
          ).toBe(priceMinor - depositMinor)
          expect(entries).toHaveLength(months)
        }
      }
    }
  })
})

describe('generateSchedule — due dates', () => {
  it('starts one month after signing, not on the signing date', () => {
    const entries = installments({ signedAt: utc(2026, 8, 9), months: 3 })
    expect(entries.map((e) => iso(e.dueDate))).toEqual([
      '2026-09-09',
      '2026-10-09',
      '2026-11-09'
    ])
  })

  it('clamps short months without degrading later dates', () => {
    const entries = installments({ signedAt: utc(2026, 1, 31), months: 4 })
    expect(entries.map((e) => iso(e.dueDate))).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31'
    ])
  })

  it('clamps into a leap February', () => {
    const entries = installments({ signedAt: utc(2028, 1, 31), months: 1 })
    expect(iso(entries[0].dueDate)).toBe('2028-02-29')
  })

  it('spans three year boundaries over a 36-month term', () => {
    const entries = installments({ signedAt: utc(2026, 8, 9), months: 36 })
    expect(iso(entries[0].dueDate)).toBe('2026-09-09')
    expect(iso(entries[35].dueDate)).toBe('2029-08-09')
  })

  it('normalises due dates to UTC midnight', () => {
    const entries = installments({
      signedAt: new Date('2026-08-09T19:22:03.101Z'),
      months: 1
    })
    expect(entries[0].dueDate.toISOString()).toBe('2026-09-09T00:00:00.000Z')
  })
})

describe('generateSchedule — rejected input', () => {
  const cases: Array<[string, Parameters<typeof generateSchedule>[0]]> = [
    ['deposit equal to price', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: 1000n, months: 12, signedAt: utc(2026, 8, 9) }],
    ['deposit greater than price', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: 1001n, months: 12, signedAt: utc(2026, 8, 9) }],
    ['negative deposit', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: -1n, months: 12, signedAt: utc(2026, 8, 9) }],
    ['zero price', { planType: 'INSTALLMENTS', priceMinor: 0n, depositMinor: 0n, months: 12, signedAt: utc(2026, 8, 9) }],
    ['negative price', { planType: 'INSTALLMENTS', priceMinor: -5n, depositMinor: 0n, months: 12, signedAt: utc(2026, 8, 9) }],
    ['zero months', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: 0n, months: 0, signedAt: utc(2026, 8, 9) }],
    ['negative months', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: 0n, months: -3, signedAt: utc(2026, 8, 9) }],
    ['fractional months', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: 0n, months: 12.5, signedAt: utc(2026, 8, 9) }],
    ['invalid signing date', { planType: 'INSTALLMENTS', priceMinor: 1000n, depositMinor: 0n, months: 12, signedAt: new Date('nonsense') }]
  ]

  for (const [label, input] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => generateSchedule(input)).toThrow(ScheduleError)
    })
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- schedule
```
Expected: FAIL, `Cannot find module '@/domain/schedule'`.

- [ ] **Step 3: Implement `src/domain/schedule.ts`**

```ts
import { addMonthsClamped, startOfUtcDay } from '@/domain/dates'

export const DEFAULT_TERM_MONTHS = 36

export type PlanType = 'FULL' | 'INSTALLMENTS'

export interface ScheduleEntryDraft {
  sequence: number
  dueDate: Date
  amountDueMinor: bigint
}

export interface ScheduleInput {
  planType: PlanType
  priceMinor: bigint
  depositMinor: bigint
  /** Ignored for FULL plans. */
  months: number
  signedAt: Date
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleError'
  }
}

export function totalScheduledMinor(entries: ScheduleEntryDraft[]): bigint {
  return entries.reduce((sum, entry) => sum + entry.amountDueMinor, 0n)
}

export function generateSchedule(input: ScheduleInput): ScheduleEntryDraft[] {
  const { planType, priceMinor, depositMinor, months, signedAt } = input

  if (Number.isNaN(signedAt.getTime())) {
    throw new ScheduleError('signedAt is not a valid date')
  }
  if (priceMinor <= 0n) {
    throw new ScheduleError('priceMinor must be greater than zero')
  }
  if (depositMinor < 0n) {
    throw new ScheduleError('depositMinor cannot be negative')
  }

  const signedDay = startOfUtcDay(signedAt)

  // A full-payment sale still gets one schedule entry. An empty schedule would
  // leave the buyer with nothing to allocate a payment against, no invoice to
  // issue, and no way to appear in the arrears report if they never pay.
  if (planType === 'FULL') {
    if (depositMinor !== 0n) {
      throw new ScheduleError('a full-payment sale cannot carry a deposit')
    }
    return [{ sequence: 1, dueDate: signedDay, amountDueMinor: priceMinor }]
  }

  if (depositMinor >= priceMinor) {
    throw new ScheduleError('depositMinor must be less than priceMinor')
  }
  if (!Number.isInteger(months) || months < 1) {
    throw new ScheduleError('months must be an integer of at least 1')
  }

  const financedMinor = priceMinor - depositMinor
  const termMonths = BigInt(months)

  // BigInt division truncates toward zero, which is floor for positive values —
  // exactly the "round down to the smallest minor unit" rule, with no exponent
  // needed because the operands are already minor units.
  const baseMinor = financedMinor / termMonths
  const finalMinor = financedMinor - baseMinor * (termMonths - 1n)

  return Array.from({ length: months }, (_, index) => {
    const sequence = index + 1
    return {
      sequence,
      dueDate: addMonthsClamped(signedDay, sequence),
      amountDueMinor: sequence === months ? finalMinor : baseMinor
    }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- schedule
```
Expected: PASS. The invariant test alone exercises 100+ price/deposit/term combinations.

- [ ] **Step 5: Commit**

```bash
git add src/domain/schedule.ts src/domain/__tests__/schedule.test.ts
git commit -m "feat(domain): amortization and schedule generation with exact remainder handling"
```

---

### Task 5: Payment allocation

**Files:**
- Create: `src/domain/allocation.ts`
- Test: `src/domain/__tests__/allocation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface AllocatableEntry { id: string; sequence: number; amountDueMinor: bigint; amountPaidMinor: bigint }`
  - `interface Allocation { entryId: string; amountMinor: bigint }`
  - `interface AllocationResult { allocations: Allocation[]; appliedMinor: bigint; overpaymentMinor: bigint }`
  - `allocatePayment(entries: AllocatableEntry[], amountMinor: bigint): AllocationResult`
  - `class AllocationError extends Error`

- [ ] **Step 1: Write the failing tests**

`src/domain/__tests__/allocation.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { AllocationError, allocatePayment, type AllocatableEntry } from '@/domain/allocation'

const entry = (
  sequence: number,
  amountDueMinor: bigint,
  amountPaidMinor = 0n
): AllocatableEntry => ({
  id: `e${sequence}`,
  sequence,
  amountDueMinor,
  amountPaidMinor
})

const threeEntries = () => [entry(1, 300n), entry(2, 300n), entry(3, 300n)]

describe('allocatePayment', () => {
  it('settles a single entry with an exact payment', () => {
    const result = allocatePayment(threeEntries(), 300n)
    expect(result.allocations).toEqual([{ entryId: 'e1', amountMinor: 300n }])
    expect(result.appliedMinor).toBe(300n)
    expect(result.overpaymentMinor).toBe(0n)
  })

  it('leaves an entry partial when the payment is short', () => {
    const result = allocatePayment(threeEntries(), 120n)
    expect(result.allocations).toEqual([{ entryId: 'e1', amountMinor: 120n }])
    expect(result.overpaymentMinor).toBe(0n)
  })

  it('cascades a large payment across three entries', () => {
    const result = allocatePayment(threeEntries(), 900n)
    expect(result.allocations).toEqual([
      { entryId: 'e1', amountMinor: 300n },
      { entryId: 'e2', amountMinor: 300n },
      { entryId: 'e3', amountMinor: 300n }
    ])
    expect(result.overpaymentMinor).toBe(0n)
  })

  it('cascades and leaves the last touched entry partial', () => {
    const result = allocatePayment(threeEntries(), 700n)
    expect(result.allocations).toEqual([
      { entryId: 'e1', amountMinor: 300n },
      { entryId: 'e2', amountMinor: 300n },
      { entryId: 'e3', amountMinor: 100n }
    ])
  })

  it('tops up an already-partial entry before moving on', () => {
    const entries = [entry(1, 300n, 250n), entry(2, 300n)]
    const result = allocatePayment(entries, 100n)
    expect(result.allocations).toEqual([
      { entryId: 'e1', amountMinor: 50n },
      { entryId: 'e2', amountMinor: 50n }
    ])
  })

  it('skips fully paid entries', () => {
    const entries = [entry(1, 300n, 300n), entry(2, 300n)]
    const result = allocatePayment(entries, 300n)
    expect(result.allocations).toEqual([{ entryId: 'e2', amountMinor: 300n }])
  })

  it('reports surplus beyond the final entry rather than discarding it', () => {
    const result = allocatePayment(threeEntries(), 1_000n)
    expect(result.appliedMinor).toBe(900n)
    expect(result.overpaymentMinor).toBe(100n)
    expect(result.allocations).toHaveLength(3)
  })

  it('reports the whole payment as overpayment when nothing is outstanding', () => {
    const entries = [entry(1, 300n, 300n)]
    const result = allocatePayment(entries, 50n)
    expect(result.allocations).toEqual([])
    expect(result.appliedMinor).toBe(0n)
    expect(result.overpaymentMinor).toBe(50n)
  })

  it('orders by sequence regardless of input order', () => {
    const result = allocatePayment([entry(3, 300n), entry(1, 300n), entry(2, 300n)], 400n)
    expect(result.allocations).toEqual([
      { entryId: 'e1', amountMinor: 300n },
      { entryId: 'e2', amountMinor: 100n }
    ])
  })

  it('never emits a zero-amount allocation', () => {
    const result = allocatePayment(threeEntries(), 600n)
    expect(result.allocations.every((a) => a.amountMinor > 0n)).toBe(true)
    expect(result.allocations).toHaveLength(2)
  })

  it('handles amounts far beyond Int32', () => {
    const result = allocatePayment([entry(1, 25_000_000_000n)], 25_000_000_000n)
    expect(result.allocations[0].amountMinor).toBe(25_000_000_000n)
  })

  it('rejects a non-positive payment', () => {
    expect(() => allocatePayment(threeEntries(), 0n)).toThrow(AllocationError)
    expect(() => allocatePayment(threeEntries(), -5n)).toThrow(AllocationError)
  })

  it('rejects an entry overpaid beyond its due amount', () => {
    expect(() => allocatePayment([entry(1, 300n, 400n)], 10n)).toThrow(AllocationError)
  })

  it('does not mutate the input entries', () => {
    const entries = threeEntries()
    allocatePayment(entries, 900n)
    expect(entries.map((e) => e.amountPaidMinor)).toEqual([0n, 0n, 0n])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- allocation
```
Expected: FAIL, `Cannot find module '@/domain/allocation'`.

- [ ] **Step 3: Implement `src/domain/allocation.ts`**

```ts
export interface AllocatableEntry {
  id: string
  sequence: number
  amountDueMinor: bigint
  amountPaidMinor: bigint
}

export interface Allocation {
  entryId: string
  amountMinor: bigint
}

export interface AllocationResult {
  allocations: Allocation[]
  /** Total actually applied to entries. */
  appliedMinor: bigint
  /** Surplus that no entry could absorb. Returned, never silently dropped. */
  overpaymentMinor: bigint
}

export class AllocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllocationError'
  }
}

/**
 * Applies a payment to the oldest unpaid entry first, cascading any excess
 * forward. Pure: the input entries are never mutated, so the caller decides
 * how the result is persisted.
 */
export function allocatePayment(
  entries: AllocatableEntry[],
  amountMinor: bigint
): AllocationResult {
  if (amountMinor <= 0n) {
    throw new AllocationError('payment amount must be greater than zero')
  }

  for (const entry of entries) {
    if (entry.amountPaidMinor > entry.amountDueMinor) {
      throw new AllocationError(
        `entry ${entry.id} is already over-allocated (${entry.amountPaidMinor} of ${entry.amountDueMinor})`
      )
    }
  }

  const ordered = [...entries].sort((a, b) => a.sequence - b.sequence)
  const allocations: Allocation[] = []
  let remaining = amountMinor

  for (const entry of ordered) {
    if (remaining === 0n) break

    const outstanding = entry.amountDueMinor - entry.amountPaidMinor
    if (outstanding <= 0n) continue

    const applied = remaining < outstanding ? remaining : outstanding
    allocations.push({ entryId: entry.id, amountMinor: applied })
    remaining -= applied
  }

  return {
    allocations,
    appliedMinor: amountMinor - remaining,
    overpaymentMinor: remaining
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- allocation
```
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/allocation.ts src/domain/__tests__/allocation.test.ts
git commit -m "feat(domain): oldest-first payment allocation with cascading overflow"
```

---

### Task 6: Installment status derivation

**Files:**
- Create: `src/domain/status.ts`
- Test: `src/domain/__tests__/status.test.ts`

**Interfaces:**
- Consumes: `differenceInDaysUtc`, `startOfUtcDay` from `@/domain/dates`.
- Produces:
  - `type InstallmentStatus = 'PAID' | 'PARTIAL' | 'OVERDUE' | 'PENDING'`
  - `interface StatusInput { dueDate: Date; amountDueMinor: bigint; amountPaidMinor: bigint }`
  - `deriveStatus(entry: StatusInput, asOf: Date): InstallmentStatus`
  - `daysLate(entry: StatusInput, asOf: Date): number`
  - `outstandingMinor(entry: StatusInput): bigint`

**Precedence decision:** `OVERDUE` wins over `PARTIAL`. A part-paid entry past its due date is still money the developer is chasing, so the arrears-relevant state is the one worth surfacing. `outstandingMinor` carries the nuance about how much is left.

- [ ] **Step 1: Write the failing tests**

`src/domain/__tests__/status.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { daysLate, deriveStatus, outstandingMinor } from '@/domain/status'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
const DUE = utc(2026, 8, 9)

const at = (amountPaidMinor: bigint, dueDate = DUE) => ({
  dueDate,
  amountDueMinor: 300n,
  amountPaidMinor
})

describe('deriveStatus', () => {
  it('is PAID when the full amount is settled', () => {
    expect(deriveStatus(at(300n), utc(2026, 12, 1))).toBe('PAID')
  })

  it('stays PAID even long after the due date', () => {
    expect(deriveStatus(at(300n), utc(2030, 1, 1))).toBe('PAID')
  })

  it('is PENDING when unpaid and the due date is in the future', () => {
    expect(deriveStatus(at(0n), utc(2026, 8, 1))).toBe('PENDING')
  })

  it('is not yet OVERDUE on the due date itself', () => {
    expect(deriveStatus(at(0n), DUE)).toBe('PENDING')
  })

  it('is not yet OVERDUE late in the evening of the due date', () => {
    expect(deriveStatus(at(0n), new Date('2026-08-09T23:59:00Z'))).toBe('PENDING')
  })

  it('is OVERDUE the day after the due date', () => {
    expect(deriveStatus(at(0n), utc(2026, 8, 10))).toBe('OVERDUE')
  })

  it('is PARTIAL when part-paid and not yet due', () => {
    expect(deriveStatus(at(100n), utc(2026, 8, 1))).toBe('PARTIAL')
  })

  it('is OVERDUE rather than PARTIAL when part-paid and past due', () => {
    expect(deriveStatus(at(100n), utc(2026, 9, 1))).toBe('OVERDUE')
  })

  it('treats a zero-amount entry as PAID', () => {
    expect(
      deriveStatus({ dueDate: DUE, amountDueMinor: 0n, amountPaidMinor: 0n }, utc(2030, 1, 1))
    ).toBe('PAID')
  })
})

describe('daysLate', () => {
  it('returns 0 for an entry that is not overdue', () => {
    expect(daysLate(at(0n), utc(2026, 8, 1))).toBe(0)
    expect(daysLate(at(0n), DUE)).toBe(0)
  })

  it('counts whole days past the due date', () => {
    expect(daysLate(at(0n), utc(2026, 8, 20))).toBe(11)
  })

  it('returns 0 once the entry is fully paid', () => {
    expect(daysLate(at(300n), utc(2026, 12, 1))).toBe(0)
  })

  it('counts lateness for a part-paid entry', () => {
    expect(daysLate(at(100n), utc(2026, 8, 20))).toBe(11)
  })
})

describe('outstandingMinor', () => {
  it('returns the unpaid remainder', () => {
    expect(outstandingMinor(at(120n))).toBe(180n)
  })

  it('never returns a negative figure', () => {
    expect(outstandingMinor(at(400n))).toBe(0n)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- status
```
Expected: FAIL, `Cannot find module '@/domain/status'`.

- [ ] **Step 3: Implement `src/domain/status.ts`**

```ts
import { differenceInDaysUtc, startOfUtcDay } from '@/domain/dates'

export type InstallmentStatus = 'PAID' | 'PARTIAL' | 'OVERDUE' | 'PENDING'

export interface StatusInput {
  dueDate: Date
  amountDueMinor: bigint
  amountPaidMinor: bigint
}

export function outstandingMinor(entry: StatusInput): bigint {
  const remainder = entry.amountDueMinor - entry.amountPaidMinor
  return remainder > 0n ? remainder : 0n
}

/**
 * Derived, never stored. An entry becomes overdue because a day passed, not
 * because a job ran — a persisted column would be wrong the moment a cron run
 * is delayed.
 *
 * OVERDUE outranks PARTIAL: a part-paid entry past its due date is still
 * arrears, and that is the state the developer needs to act on.
 */
export function deriveStatus(entry: StatusInput, asOf: Date): InstallmentStatus {
  if (outstandingMinor(entry) === 0n) return 'PAID'
  if (startOfUtcDay(asOf).getTime() > startOfUtcDay(entry.dueDate).getTime()) return 'OVERDUE'
  return entry.amountPaidMinor > 0n ? 'PARTIAL' : 'PENDING'
}

export function daysLate(entry: StatusInput, asOf: Date): number {
  if (deriveStatus(entry, asOf) !== 'OVERDUE') return 0
  return differenceInDaysUtc(asOf, entry.dueDate)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- status
```
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/status.ts src/domain/__tests__/status.test.ts
git commit -m "feat(domain): derived installment status and lateness"
```

---

### Task 7: Unit name generation from a pattern

**Files:**
- Create: `src/domain/units.ts`
- Test: `src/domain/__tests__/units.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `columnLetters(n: number): string` — 1→A, 26→Z, 27→AA
  - `interface UnitNameInput { floors: number; unitsPerFloor: number; pattern: string; startFloor: number }`
  - `interface GeneratedUnit { name: string; floor: number; indexOnFloor: number }`
  - `generateUnitNames(input: UnitNameInput): GeneratedUnit[]`
  - `class UnitPatternError extends Error`
  - `const UNIT_PATTERN_PRESETS: ReadonlyArray<{ label: string; pattern: string; example: string }>`

- [ ] **Step 1: Write the failing tests**

`src/domain/__tests__/units.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  UNIT_PATTERN_PRESETS,
  UnitPatternError,
  columnLetters,
  generateUnitNames
} from '@/domain/units'

const names = (input: Parameters<typeof generateUnitNames>[0]) =>
  generateUnitNames(input).map((u) => u.name)

describe('columnLetters', () => {
  it('maps the first 26 positions to single letters', () => {
    expect(columnLetters(1)).toBe('A')
    expect(columnLetters(26)).toBe('Z')
  })

  it('continues spreadsheet-style past 26 instead of wrapping', () => {
    expect(columnLetters(27)).toBe('AA')
    expect(columnLetters(28)).toBe('AB')
    expect(columnLetters(52)).toBe('AZ')
    expect(columnLetters(53)).toBe('BA')
  })

  it('rejects non-positive and fractional input', () => {
    expect(() => columnLetters(0)).toThrow(RangeError)
    expect(() => columnLetters(-1)).toThrow(RangeError)
    expect(() => columnLetters(1.5)).toThrow(RangeError)
  })
})

describe('generateUnitNames', () => {
  it('generates zero-padded numeric names', () => {
    expect(names({ floors: 2, unitsPerFloor: 3, pattern: '{floor}{index:02}', startFloor: 4 }))
      .toEqual(['401', '402', '403', '501', '502', '503'])
  })

  it('generates letter names', () => {
    expect(names({ floors: 2, unitsPerFloor: 2, pattern: '{floor}{letter}', startFloor: 4 }))
      .toEqual(['4A', '4B', '5A', '5B'])
  })

  it('does not produce duplicates past 26 units on a floor', () => {
    const result = names({ floors: 1, unitsPerFloor: 28, pattern: '{floor}{letter}', startFloor: 1 })
    expect(result[25]).toBe('1Z')
    expect(result[26]).toBe('1AA')
    expect(result[27]).toBe('1AB')
    expect(new Set(result).size).toBe(28)
  })

  it('supports unpadded index and arbitrary literal text', () => {
    expect(names({ floors: 1, unitsPerFloor: 2, pattern: 'Unit {floor}-{index}', startFloor: 2 }))
      .toEqual(['Unit 2-1', 'Unit 2-2'])
  })

  it('supports a padded floor token', () => {
    expect(names({ floors: 1, unitsPerFloor: 1, pattern: 'B{floor:02}{index:02}', startFloor: 7 }))
      .toEqual(['B0701'])
  })

  it('starts numbering from startFloor', () => {
    const units = generateUnitNames({
      floors: 2,
      unitsPerFloor: 1,
      pattern: '{floor}{index:02}',
      startFloor: 10
    })
    expect(units.map((u) => u.floor)).toEqual([10, 11])
    expect(units.map((u) => u.name)).toEqual(['1001', '1101'])
  })

  it('reports the index within each floor', () => {
    const units = generateUnitNames({
      floors: 2,
      unitsPerFloor: 2,
      pattern: '{floor}{index}',
      startFloor: 1
    })
    expect(units.map((u) => u.indexOnFloor)).toEqual([1, 2, 1, 2])
  })

  it('generates every unit for a realistic building', () => {
    expect(
      generateUnitNames({ floors: 12, unitsPerFloor: 8, pattern: '{floor}{index:02}', startFloor: 1 })
    ).toHaveLength(96)
  })

  it('rejects a pattern with no per-unit token, which would duplicate names', () => {
    expect(() =>
      generateUnitNames({ floors: 2, unitsPerFloor: 3, pattern: 'Flat {floor}', startFloor: 1 })
    ).toThrow(UnitPatternError)
  })

  it('rejects an unknown token', () => {
    expect(() =>
      generateUnitNames({ floors: 1, unitsPerFloor: 1, pattern: '{block}{index}', startFloor: 1 })
    ).toThrow(UnitPatternError)
  })

  it('rejects non-positive dimensions', () => {
    const base = { pattern: '{floor}{index:02}', startFloor: 1 }
    expect(() => generateUnitNames({ ...base, floors: 0, unitsPerFloor: 4 })).toThrow(UnitPatternError)
    expect(() => generateUnitNames({ ...base, floors: 4, unitsPerFloor: 0 })).toThrow(UnitPatternError)
    expect(() => generateUnitNames({ ...base, floors: 1.5, unitsPerFloor: 4 })).toThrow(UnitPatternError)
  })

  it('exposes presets that all generate successfully', () => {
    expect(UNIT_PATTERN_PRESETS.length).toBeGreaterThanOrEqual(2)
    for (const preset of UNIT_PATTERN_PRESETS) {
      expect(() =>
        generateUnitNames({ floors: 1, unitsPerFloor: 2, pattern: preset.pattern, startFloor: 4 })
      ).not.toThrow()
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- units
```
Expected: FAIL, `Cannot find module '@/domain/units'`.

- [ ] **Step 3: Implement `src/domain/units.ts`**

```ts
export class UnitPatternError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnitPatternError'
  }
}

export interface UnitNameInput {
  floors: number
  unitsPerFloor: number
  pattern: string
  startFloor: number
}

export interface GeneratedUnit {
  name: string
  floor: number
  indexOnFloor: number
}

export const UNIT_PATTERN_PRESETS: ReadonlyArray<{
  label: string
  pattern: string
  example: string
}> = Object.freeze([
  { label: 'Numbered (401, 402)', pattern: '{floor}{index:02}', example: '401' },
  { label: 'Lettered (4A, 4B)', pattern: '{floor}{letter}', example: '4A' },
  { label: 'Named (Unit 4-1)', pattern: 'Unit {floor}-{index}', example: 'Unit 4-1' }
])

const TOKEN = /\{([a-zA-Z]+)(?::(\d+))?\}/g
const KNOWN_TOKENS = new Set(['floor', 'index', 'letter'])
const PER_UNIT_TOKENS = ['index', 'letter']

/** 1 → A, 26 → Z, 27 → AA. Spreadsheet-style, so it never wraps into a duplicate. */
export function columnLetters(n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`columnLetters requires a positive integer, received ${n}`)
  }

  let result = ''
  let remaining = n
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    remaining = Math.floor((remaining - 1) / 26)
  }
  return result
}

function assertPattern(pattern: string): void {
  const found: string[] = []
  for (const match of pattern.matchAll(TOKEN)) {
    const token = match[1]
    if (!KNOWN_TOKENS.has(token)) {
      throw new UnitPatternError(
        `Unknown token {${token}}. Supported tokens: {floor}, {index}, {letter}, with optional padding such as {index:02}.`
      )
    }
    found.push(token)
  }

  if (!found.some((token) => PER_UNIT_TOKENS.includes(token))) {
    throw new UnitPatternError(
      'Pattern must contain {index} or {letter}, otherwise every unit on a floor gets the same name.'
    )
  }
}

function expand(pattern: string, floor: number, indexOnFloor: number): string {
  return pattern.replace(TOKEN, (_full, token: string, pad?: string) => {
    const value =
      token === 'floor' ? String(floor)
      : token === 'index' ? String(indexOnFloor)
      : columnLetters(indexOnFloor)
    return pad ? value.padStart(Number(pad), '0') : value
  })
}

export function generateUnitNames(input: UnitNameInput): GeneratedUnit[] {
  const { floors, unitsPerFloor, pattern, startFloor } = input

  if (!Number.isInteger(floors) || floors < 1) {
    throw new UnitPatternError('floors must be an integer of at least 1')
  }
  if (!Number.isInteger(unitsPerFloor) || unitsPerFloor < 1) {
    throw new UnitPatternError('unitsPerFloor must be an integer of at least 1')
  }
  if (!Number.isInteger(startFloor)) {
    throw new UnitPatternError('startFloor must be an integer')
  }

  assertPattern(pattern)

  const units: GeneratedUnit[] = []
  for (let f = 0; f < floors; f++) {
    const floor = startFloor + f
    for (let indexOnFloor = 1; indexOnFloor <= unitsPerFloor; indexOnFloor++) {
      units.push({ name: expand(pattern, floor, indexOnFloor), floor, indexOnFloor })
    }
  }
  return units
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```
Expected: PASS across all domain suites. This is the milestone where every piece of logic the spec asked to be unit-tested is complete and green, with no database in existence yet.

- [ ] **Step 5: Commit**

```bash
git add src/domain/units.ts src/domain/__tests__/units.test.ts
git commit -m "feat(domain): unit name generation with non-wrapping letter sequences"
```

---

### Task 8: Prisma schema

**Files:**
- Create: `prisma/schema.prisma`, `src/server/db.ts`
- Test: `src/domain/__tests__/schema-contract.test.ts`

**Interfaces:**
- Consumes: nothing at runtime.
- Produces: the generated Prisma client, and `prisma` (the singleton) from `@/server/db`.

- [ ] **Step 1: Write `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserRole {
  ADMIN
  AGENT
  BUYER
}

enum UnitStatus {
  AVAILABLE
  RESERVED
  SOLD
}

enum PlanType {
  FULL
  INSTALLMENTS
}

enum SaleStatus {
  ACTIVE
  COMPLETED
  CANCELLED
}

enum PaymentMethod {
  BANK_TRANSFER
  MOBILE_MONEY
  CASH
  CHEQUE
  OTHER
}

/// EMAIL and SMS both exist from day one so adding SMS delivery later
/// requires an adapter and a config flag, never a migration.
enum ReminderChannel {
  EMAIL
  SMS
}

enum DocumentType {
  INVOICE
  RECEIPT
  STATEMENT
}

enum NotificationStatus {
  PENDING
  SENT
  FAILED
}

model Organization {
  id          String   @id @default(cuid())
  name        String
  slug        String   @unique
  logoUrl     String?
  /// Monotonic counter backing per-org document numbering.
  documentSeq Int      @default(0)
  createdAt   DateTime @default(now())

  users         User[]
  projects      Project[]
  buyers        Buyer[]
  sales         Sale[]
  payments      Payment[]
  documents     Document[]
  notifications NotificationLog[]
}

model User {
  id           String   @id @default(cuid())
  orgId        String
  email        String   @unique
  passwordHash String
  fullName     String
  role         UserRole
  createdAt    DateTime @default(now())

  org   Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  buyer Buyer?

  @@index([orgId])
}

model Project {
  id                    String            @id @default(cuid())
  orgId                 String
  name                  String
  location              String
  /// ISO-4217 code. There is no default — every project states its own.
  currency              String
  expectedCompletion    DateTime
  floors                Int
  unitsPerFloor         Int
  startFloor            Int               @default(1)
  namingPattern         String
  reminderDaysBefore    Int               @default(7)
  overdueNoticeDaysAfter Int              @default(3)
  reminderChannels      ReminderChannel[] @default([EMAIL])
  createdAt             DateTime          @default(now())

  org   Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  units Unit[]
  sales Sale[]

  @@index([orgId])
}

model Unit {
  id         String     @id @default(cuid())
  projectId  String
  name       String
  floor      Int
  bedrooms   Int
  sizeSqm    Decimal    @db.Decimal(10, 2)
  /// Minor units. BigInt because a NGN tower unit overflows Int32.
  priceMinor BigInt
  status     UnitStatus @default(AVAILABLE)
  createdAt  DateTime   @default(now())

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  sale    Sale?

  @@unique([projectId, name])
  @@index([projectId, floor])
  @@index([projectId, status])
}

model Buyer {
  id        String   @id @default(cuid())
  orgId     String
  userId    String   @unique
  fullName  String
  /// Stored E.164 with country code, validated at registration.
  phone     String
  email     String
  address   String?
  smsOptIn  Boolean  @default(true)
  createdAt DateTime @default(now())

  org   Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  user  User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  sales Sale[]

  @@index([orgId])
}

model Sale {
  id              String     @id @default(cuid())
  orgId           String
  projectId       String
  unitId          String     @unique
  buyerId         String
  planType        PlanType
  /// Snapshot at signing. Repricing the unit must not alter a signed contract.
  priceMinor      BigInt
  depositMinor    BigInt     @default(0)
  currency        String
  termMonths      Int?
  signedAt        DateTime
  status          SaleStatus @default(ACTIVE)
  createdByUserId String
  createdAt       DateTime   @default(now())

  org             Organization    @relation(fields: [orgId], references: [id], onDelete: Cascade)
  project         Project         @relation(fields: [projectId], references: [id], onDelete: Cascade)
  unit            Unit            @relation(fields: [unitId], references: [id], onDelete: Cascade)
  buyer           Buyer           @relation(fields: [buyerId], references: [id], onDelete: Cascade)
  scheduleEntries ScheduleEntry[]
  payments        Payment[]
  documents       Document[]

  @@index([orgId, status])
  @@index([buyerId])
  @@index([projectId])
}

model ScheduleEntry {
  id             String    @id @default(cuid())
  saleId         String
  sequence       Int
  dueDate        DateTime
  amountDueMinor BigInt
  /// Maintained transactionally as the sum of this entry's allocations.
  /// Status is NOT stored — it is derived from this plus the current date.
  amountPaidMinor BigInt   @default(0)
  paidAt         DateTime?

  sale          Sale                @relation(fields: [saleId], references: [id], onDelete: Cascade)
  allocations   PaymentAllocation[]
  notifications NotificationLog[]
  documents     Document[]

  @@unique([saleId, sequence])
  @@index([dueDate])
  @@index([saleId])
}

model Payment {
  id               String        @id @default(cuid())
  orgId            String
  saleId           String
  amountMinor      BigInt
  receivedAt       DateTime
  method           PaymentMethod
  reference        String?
  note             String?
  recordedByUserId String
  /// Payments are immutable. A mistake is voided, never edited or deleted.
  voidedAt         DateTime?
  voidedByUserId   String?
  voidReason       String?
  createdAt        DateTime      @default(now())

  org         Organization        @relation(fields: [orgId], references: [id], onDelete: Cascade)
  sale        Sale                @relation(fields: [saleId], references: [id], onDelete: Cascade)
  allocations PaymentAllocation[]
  document    Document?

  @@index([saleId, receivedAt])
  @@index([orgId])
}

model PaymentAllocation {
  id              String @id @default(cuid())
  paymentId       String
  scheduleEntryId String
  amountMinor     BigInt

  payment       Payment       @relation(fields: [paymentId], references: [id], onDelete: Cascade)
  scheduleEntry ScheduleEntry @relation(fields: [scheduleEntryId], references: [id], onDelete: Cascade)

  @@unique([paymentId, scheduleEntryId])
  @@index([scheduleEntryId])
}

model Document {
  id              String       @id @default(cuid())
  orgId           String
  saleId          String
  type            DocumentType
  /// Human-facing, stable, sequential per organisation, e.g. INV-000042.
  number          String
  sequence        Int
  /// Set for INVOICE. Unique so an entry cannot be double-invoiced.
  scheduleEntryId String?      @unique
  /// Set for RECEIPT. Unique so a payment cannot yield two receipts.
  paymentId       String?      @unique
  createdAt       DateTime     @default(now())

  org           Organization   @relation(fields: [orgId], references: [id], onDelete: Cascade)
  sale          Sale           @relation(fields: [saleId], references: [id], onDelete: Cascade)
  scheduleEntry ScheduleEntry? @relation(fields: [scheduleEntryId], references: [id], onDelete: Cascade)
  payment       Payment?       @relation(fields: [paymentId], references: [id], onDelete: Cascade)

  @@unique([orgId, number])
  @@index([saleId, type])
}

model NotificationLog {
  id                String             @id @default(cuid())
  orgId             String
  scheduleEntryId   String
  channel           ReminderChannel
  templateKey       String
  /// Email address or E.164 number, depending on channel.
  destination       String
  status            NotificationStatus @default(PENDING)
  providerMessageId String?
  error             String?
  sentAt            DateTime?
  createdAt         DateTime           @default(now())

  org           Organization  @relation(fields: [orgId], references: [id], onDelete: Cascade)
  scheduleEntry ScheduleEntry @relation(fields: [scheduleEntryId], references: [id], onDelete: Cascade)

  /// The idempotency guard: a retried cron run cannot double-send.
  @@unique([scheduleEntryId, templateKey, channel])
  @@index([orgId, createdAt])
}
```

- [ ] **Step 2: Write the schema contract test**

This guards the schema decisions the spec is most likely to lose in a later edit. It reads the schema file as text — no database needed.

`src/domain/__tests__/schema-contract.test.ts`:
```ts
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const schema = readFileSync(
  path.resolve(__dirname, '../../../prisma/schema.prisma'),
  'utf8'
)

describe('schema contract', () => {
  it('stores every monetary field as BigInt', () => {
    const moneyFields = schema.match(/^\s*\w*[Mm]inor\s+\S+/gm) ?? []
    expect(moneyFields.length).toBeGreaterThan(0)
    for (const field of moneyFields) {
      expect(field, `${field.trim()} must be BigInt`).toMatch(/BigInt/)
    }
  })

  it('never stores a derived installment status', () => {
    expect(schema).not.toMatch(/model ScheduleEntry[\s\S]*?status\s+InstallmentStatus/)
  })

  it('declares SMS as a reminder channel before it is implemented', () => {
    expect(schema).toMatch(/enum ReminderChannel[\s\S]*?SMS/)
  })

  it('guards reminder idempotency with a unique index', () => {
    expect(schema).toContain('@@unique([scheduleEntryId, templateKey, channel])')
  })

  it('keeps unit names unique within a project', () => {
    expect(schema).toContain('@@unique([projectId, name])')
  })

  it('hardcodes no default currency', () => {
    expect(schema).not.toMatch(/currency\s+String\s+@default/)
  })
})
```

- [ ] **Step 3: Run the contract test**

```bash
npm test -- schema-contract
```
Expected: PASS, 6 tests.

- [ ] **Step 4: Create the Prisma client singleton**

`src/server/db.ts`:
```ts
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
```

- [ ] **Step 5: Generate the client and push the schema**

Set `DATABASE_URL` in `.env` to the Neon connection string first.

```bash
npx prisma generate
npx prisma db push
```
Expected: `Your database is now in sync with your Prisma schema.`

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma src/server/db.ts src/domain/__tests__/schema-contract.test.ts
git commit -m "feat(db): Prisma schema with BigInt money, derived status, SMS-ready notifications"
```

---

### Task 9: Seed data

**Files:**
- Create: `prisma/seed.ts`

**Interfaces:**
- Consumes: `toMinor` from `@/domain/currency`, `generateUnitNames` from `@/domain/units`, `generateSchedule` from `@/domain/schedule`, `prisma` from `@/server/db`.
- Produces: a populated database with logins `admin@sunrise.test`, `agent@sunrise.test`, `amina@buyer.test`, `kwame@buyer.test`, `zainab@buyer.test`, `joseph@buyer.test` — all password `password123`.

The seed must reuse the real domain functions rather than hand-writing schedules. Hand-written seed data hides bugs by disagreeing with production logic.

- [ ] **Step 1: Write `prisma/seed.ts`**

```ts
import { PrismaClient, type PaymentMethod, type PlanType } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { toMinor } from '../src/domain/currency'
import { allocatePayment } from '../src/domain/allocation'
import { generateSchedule } from '../src/domain/schedule'
import { generateUnitNames } from '../src/domain/units'

const prisma = new PrismaClient()
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

async function main() {
  // Order matters: children before parents.
  await prisma.notificationLog.deleteMany()
  await prisma.document.deleteMany()
  await prisma.paymentAllocation.deleteMany()
  await prisma.payment.deleteMany()
  await prisma.scheduleEntry.deleteMany()
  await prisma.sale.deleteMany()
  await prisma.unit.deleteMany()
  await prisma.buyer.deleteMany()
  await prisma.project.deleteMany()
  await prisma.user.deleteMany()
  await prisma.organization.deleteMany()

  const passwordHash = await bcrypt.hash('password123', 10)

  const org = await prisma.organization.create({
    data: { name: 'Sunrise Developments', slug: 'sunrise' }
  })

  const admin = await prisma.user.create({
    data: {
      orgId: org.id,
      email: 'admin@sunrise.test',
      passwordHash,
      fullName: 'Adaeze Okonkwo',
      role: 'ADMIN'
    }
  })

  const agent = await prisma.user.create({
    data: {
      orgId: org.id,
      email: 'agent@sunrise.test',
      passwordHash,
      fullName: 'Tunde Bakare',
      role: 'AGENT'
    }
  })

  // Two currencies, deliberately: one two-decimal (NGN) and one that is also
  // two-decimal but a different market (KES), proving nothing is USD-bound.
  const lagos = await prisma.project.create({
    data: {
      orgId: org.id,
      name: 'Sunrise Heights',
      location: 'Lekki Phase 1, Lagos, Nigeria',
      currency: 'NGN',
      expectedCompletion: utc(2028, 6, 30),
      floors: 4,
      unitsPerFloor: 6,
      startFloor: 1,
      namingPattern: '{floor}{index:02}',
      reminderDaysBefore: 7,
      overdueNoticeDaysAfter: 3
    }
  })

  const nairobi = await prisma.project.create({
    data: {
      orgId: org.id,
      name: 'Riverside Court',
      location: 'Westlands, Nairobi, Kenya',
      currency: 'KES',
      expectedCompletion: utc(2027, 12, 31),
      floors: 4,
      unitsPerFloor: 6,
      startFloor: 1,
      namingPattern: '{floor}{letter}',
      reminderDaysBefore: 10,
      overdueNoticeDaysAfter: 5
    }
  })

  async function createUnits(
    project: { id: string; floors: number; unitsPerFloor: number; namingPattern: string; startFloor: number },
    currency: string,
    priceByBedrooms: Record<number, string>
  ) {
    const drafts = generateUnitNames({
      floors: project.floors,
      unitsPerFloor: project.unitsPerFloor,
      pattern: project.namingPattern,
      startFloor: project.startFloor
    })

    await prisma.unit.createMany({
      data: drafts.map((draft) => {
        const bedrooms = (draft.indexOnFloor % 3) + 1
        return {
          projectId: project.id,
          name: draft.name,
          floor: draft.floor,
          bedrooms,
          sizeSqm: bedrooms * 45,
          priceMinor: toMinor(priceByBedrooms[bedrooms], currency)
        }
      })
    })
  }

  await createUnits(lagos, 'NGN', { 1: '85000000', 2: '145000000', 3: '250000000' })
  await createUnits(nairobi, 'KES', { 1: '7500000', 2: '11200000', 3: '18400000' })

  async function createBuyer(
    fullName: string,
    email: string,
    phone: string,
    address: string | null
  ) {
    const user = await prisma.user.create({
      data: { orgId: org.id, email, passwordHash, fullName, role: 'BUYER' }
    })
    return prisma.buyer.create({
      data: { orgId: org.id, userId: user.id, fullName, phone, email, address }
    })
  }

  /**
   * Creates a sale using the real domain functions, then applies payments
   * through the real allocation function.
   */
  async function createSale(opts: {
    projectId: string
    currency: string
    buyerId: string
    unitName: string
    planType: PlanType
    depositMajor: string
    termMonths: number | null
    signedAt: Date
    payments: Array<{ amountMajor: string; receivedAt: Date; method: PaymentMethod; reference: string }>
  }) {
    const unit = await prisma.unit.findFirstOrThrow({
      where: { projectId: opts.projectId, name: opts.unitName }
    })

    const depositMinor = toMinor(opts.depositMajor, opts.currency)
    const drafts = generateSchedule({
      planType: opts.planType,
      priceMinor: unit.priceMinor,
      depositMinor,
      months: opts.termMonths ?? 0,
      signedAt: opts.signedAt
    })

    const sale = await prisma.sale.create({
      data: {
        orgId: org.id,
        projectId: opts.projectId,
        unitId: unit.id,
        buyerId: opts.buyerId,
        planType: opts.planType,
        priceMinor: unit.priceMinor,
        depositMinor,
        currency: opts.currency,
        termMonths: opts.termMonths,
        signedAt: opts.signedAt,
        createdByUserId: agent.id,
        scheduleEntries: { create: drafts }
      }
    })

    await prisma.unit.update({ where: { id: unit.id }, data: { status: 'SOLD' } })

    for (const p of opts.payments) {
      const entries = await prisma.scheduleEntry.findMany({
        where: { saleId: sale.id },
        orderBy: { sequence: 'asc' }
      })

      const { allocations } = allocatePayment(
        entries.map((e) => ({
          id: e.id,
          sequence: e.sequence,
          amountDueMinor: e.amountDueMinor,
          amountPaidMinor: e.amountPaidMinor
        })),
        toMinor(p.amountMajor, opts.currency)
      )

      const payment = await prisma.payment.create({
        data: {
          orgId: org.id,
          saleId: sale.id,
          amountMinor: toMinor(p.amountMajor, opts.currency),
          receivedAt: p.receivedAt,
          method: p.method,
          reference: p.reference,
          recordedByUserId: agent.id,
          allocations: { create: allocations.map((a) => ({ scheduleEntryId: a.entryId, amountMinor: a.amountMinor })) }
        }
      })

      for (const allocation of allocations) {
        const entry = entries.find((e) => e.id === allocation.entryId)!
        const newPaid = entry.amountPaidMinor + allocation.amountMinor
        await prisma.scheduleEntry.update({
          where: { id: allocation.entryId },
          data: {
            amountPaidMinor: newPaid,
            paidAt: newPaid >= entry.amountDueMinor ? p.receivedAt : null
          }
        })
      }
      void payment
    }

    return sale
  }

  const amina = await createBuyer('Amina Yusuf', 'amina@buyer.test', '+2348031234567', '14 Admiralty Way, Lekki, Lagos')
  const kwame = await createBuyer('Kwame Mensah', 'kwame@buyer.test', '+254712345678', 'Riverside Drive, Nairobi')
  const zainab = await createBuyer('Zainab Bello', 'zainab@buyer.test', '+2347098765432', null)
  const joseph = await createBuyer('Joseph Otieno', 'joseph@buyer.test', '+254733222111', 'Ngong Road, Nairobi')

  // 1. Full payment, settled.
  await createSale({
    projectId: lagos.id, currency: 'NGN', buyerId: amina.id, unitName: '102',
    planType: 'FULL', depositMajor: '0', termMonths: null, signedAt: utc(2026, 3, 2),
    payments: [{ amountMajor: '145000000', receivedAt: utc(2026, 3, 2), method: 'BANK_TRANSFER', reference: 'GTB/2026/03/0021' }]
  })

  // 2. 36-month plan, fully current — five installments paid on time.
  await createSale({
    projectId: nairobi.id, currency: 'KES', buyerId: kwame.id, unitName: '2B',
    planType: 'INSTALLMENTS', depositMajor: '2000000', termMonths: 36, signedAt: utc(2026, 2, 15),
    payments: [1, 2, 3, 4, 5].map((m) => ({
      amountMajor: '255556', receivedAt: utc(2026, 2 + m, 15), method: 'MOBILE_MONEY' as PaymentMethod,
      reference: `MPESA-RJ${m}K4T2X9`
    }))
  })

  // 3. Partial payment outstanding on the current installment.
  await createSale({
    projectId: lagos.id, currency: 'NGN', buyerId: zainab.id, unitName: '305',
    planType: 'INSTALLMENTS', depositMajor: '25000000', termMonths: 36, signedAt: utc(2026, 5, 20),
    payments: [
      { amountMajor: '1666666.66', receivedAt: utc(2026, 6, 20), method: 'BANK_TRANSFER', reference: 'ZEN/2026/06/8841' },
      { amountMajor: '800000', receivedAt: utc(2026, 7, 22), method: 'BANK_TRANSFER', reference: 'ZEN/2026/07/9002' }
    ]
  })

  // 4. Several months in arrears, so the arrears report has content on day one.
  await createSale({
    projectId: nairobi.id, currency: 'KES', buyerId: joseph.id, unitName: '4C',
    planType: 'INSTALLMENTS', depositMajor: '1500000', termMonths: 36, signedAt: utc(2026, 1, 10),
    payments: [
      { amountMajor: '469445', receivedAt: utc(2026, 2, 10), method: 'CASH', reference: 'RCPT-0091' },
      { amountMajor: '469445', receivedAt: utc(2026, 3, 12), method: 'CASH', reference: 'RCPT-0114' }
    ]
  })

  console.log('Seeded:', {
    org: org.name,
    projects: 2,
    units: await prisma.unit.count(),
    sales: await prisma.sale.count(),
    scheduleEntries: await prisma.scheduleEntry.count(),
    admin: admin.email,
    agent: agent.email
  })
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Run the seed**

```bash
npm run db:seed
```
Expected: a summary line reporting 48 units, 4 sales, and a three-figure schedule-entry count.

- [ ] **Step 3: Verify the arrears fixture is genuinely overdue**

```bash
npx prisma studio
```
Confirm Joseph Otieno's sale has unpaid `ScheduleEntry` rows with `dueDate` before today. If the seed dates have aged past relevance, shift `signedAt` values forward — the fixture is only useful while it is actually in arrears.

- [ ] **Step 4: Commit**

```bash
git add prisma/seed.ts
git commit -m "feat(db): seed two-currency demo data driven by the real domain functions"
```

---

### Task 10: Authentication and session guards

**Files:**
- Create: `src/server/auth.ts`, `src/server/session.ts`, `src/types/next-auth.d.ts`, `src/middleware.ts`
- Test: `src/server/__tests__/session.test.ts`

**Interfaces:**
- Consumes: `prisma` from `@/server/db`.
- Produces:
  - `auth`, `signIn`, `signOut`, `handlers` from `@/server/auth`
  - `interface SessionActor { userId: string; orgId: string; role: 'ADMIN' | 'AGENT' | 'BUYER'; buyerId: string | null; fullName: string; email: string }`
  - `requireUser(): Promise<SessionActor>`
  - `requireStaff(): Promise<SessionActor>` — ADMIN or AGENT
  - `requireAdmin(): Promise<SessionActor>`
  - `requireBuyer(): Promise<SessionActor & { buyerId: string }>`
  - `class AuthorizationError extends Error`
  - `assertRole(actor, allowed)` — the pure part, unit tested

- [ ] **Step 1: Write the failing test for the pure guard**

`src/server/__tests__/session.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { AuthorizationError, assertRole, type SessionActor } from '@/server/session'

const actor = (role: SessionActor['role'], buyerId: string | null = null): SessionActor => ({
  userId: 'u1',
  orgId: 'o1',
  role,
  buyerId,
  fullName: 'Test User',
  email: 'test@example.com'
})

describe('assertRole', () => {
  it('allows a permitted role', () => {
    expect(() => assertRole(actor('ADMIN'), ['ADMIN', 'AGENT'])).not.toThrow()
    expect(() => assertRole(actor('AGENT'), ['ADMIN', 'AGENT'])).not.toThrow()
  })

  it('rejects a role outside the allowed set', () => {
    expect(() => assertRole(actor('BUYER'), ['ADMIN', 'AGENT'])).toThrow(AuthorizationError)
    expect(() => assertRole(actor('AGENT'), ['ADMIN'])).toThrow(AuthorizationError)
  })

  it('does not leak the allowed roles in the error message', () => {
    try {
      assertRole(actor('BUYER'), ['ADMIN'])
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).not.toContain('ADMIN')
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- session
```
Expected: FAIL, `Cannot find module '@/server/session'`.

- [ ] **Step 3: Implement `src/server/auth.ts`**

```ts
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '@/server/db'

const CredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
})

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = CredentialsSchema.safeParse(raw)
        if (!parsed.success) return null

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email.toLowerCase() },
          include: { buyer: { select: { id: true } } }
        })

        // Always run a hash comparison, even when the user does not exist, so
        // response timing does not reveal which emails are registered.
        const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu'
        const ok = await bcrypt.compare(parsed.data.password, hash)
        if (!user || !ok) return null

        return {
          id: user.id,
          email: user.email,
          name: user.fullName,
          orgId: user.orgId,
          role: user.role,
          buyerId: user.buyer?.id ?? null
        }
      }
    })
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.orgId = user.orgId
        token.role = user.role
        token.buyerId = user.buyerId
      }
      return token
    },
    session({ session, token }) {
      session.user.id = token.sub as string
      session.user.orgId = token.orgId as string
      session.user.role = token.role as 'ADMIN' | 'AGENT' | 'BUYER'
      session.user.buyerId = (token.buyerId as string | null) ?? null
      return session
    }
  }
})
```

- [ ] **Step 4: Implement `src/types/next-auth.d.ts`**

```ts
import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface User {
    orgId: string
    role: 'ADMIN' | 'AGENT' | 'BUYER'
    buyerId: string | null
  }

  interface Session {
    user: {
      id: string
      orgId: string
      role: 'ADMIN' | 'AGENT' | 'BUYER'
      buyerId: string | null
    } & DefaultSession['user']
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    orgId: string
    role: 'ADMIN' | 'AGENT' | 'BUYER'
    buyerId: string | null
  }
}
```

- [ ] **Step 5: Implement `src/server/session.ts`**

```ts
import { redirect } from 'next/navigation'
import { auth } from '@/server/auth'

export type Role = 'ADMIN' | 'AGENT' | 'BUYER'

export interface SessionActor {
  userId: string
  orgId: string
  role: Role
  buyerId: string | null
  fullName: string
  email: string
}

export class AuthorizationError extends Error {
  constructor() {
    // Deliberately vague: the message must not disclose which roles qualify.
    super('You do not have access to this resource.')
    this.name = 'AuthorizationError'
  }
}

export function assertRole(actor: SessionActor, allowed: Role[]): void {
  if (!allowed.includes(actor.role)) throw new AuthorizationError()
}

export async function requireUser(): Promise<SessionActor> {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  return {
    userId: session.user.id,
    orgId: session.user.orgId,
    role: session.user.role,
    buyerId: session.user.buyerId,
    fullName: session.user.name ?? '',
    email: session.user.email ?? ''
  }
}

export async function requireStaff(): Promise<SessionActor> {
  const actor = await requireUser()
  assertRole(actor, ['ADMIN', 'AGENT'])
  return actor
}

export async function requireAdmin(): Promise<SessionActor> {
  const actor = await requireUser()
  assertRole(actor, ['ADMIN'])
  return actor
}

export async function requireBuyer(): Promise<SessionActor & { buyerId: string }> {
  const actor = await requireUser()
  assertRole(actor, ['BUYER'])
  if (!actor.buyerId) throw new AuthorizationError()
  return { ...actor, buyerId: actor.buyerId }
}
```

- [ ] **Step 6: Add the auth route handler and middleware**

`src/app/api/auth/[...nextauth]/route.ts`:
```ts
import { handlers } from '@/server/auth'

export const { GET, POST } = handlers
```

`src/middleware.ts`:
```ts
export { auth as middleware } from '@/server/auth'

export const config = {
  matcher: ['/projects/:path*', '/sales/:path*', '/arrears/:path*', '/dashboard/:path*']
}
```

- [ ] **Step 7: Run tests and typecheck**

```bash
npm test -- session
npm run typecheck
```
Expected: PASS, 3 tests; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/server/auth.ts src/server/session.ts src/types src/middleware.ts src/app/api/auth src/server/__tests__
git commit -m "feat(auth): credentials auth with org-scoped session actor and role guards"
```

---

### Task 11: Projects and units services

**Files:**
- Create: `src/server/services/projects.ts`, `src/server/services/units.ts`
- Test: `src/server/__tests__/projects.test.ts`

**Interfaces:**
- Consumes: `prisma`, `generateUnitNames`, `toMinor`, `isSupportedCurrency`, `SessionActor`.
- Produces:
  - `CreateProjectInput` (Zod schema `CreateProjectSchema`) and `createProject(actor, input): Promise<{ id: string; unitCount: number }>`
  - `listProjects(actor)`
  - `getProjectInventory(actor, projectId): Promise<ProjectInventory>` where `ProjectInventory = { project: …; floors: Array<{ floor: number; units: InventoryUnit[]; available: number; total: number }> }`
  - `updateUnit(actor, unitId, patch)` — rename / reprice / change bedrooms / size
  - `reserveUnit(tx, unitId): Promise<boolean>` — conditional update, `false` when already taken
  - `class ServiceError extends Error` (in `src/server/services/errors.ts`)

- [ ] **Step 1: Write the failing test for input validation**

`src/server/__tests__/projects.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { CreateProjectSchema } from '@/server/services/projects'

const valid = {
  name: 'Sunrise Heights',
  location: 'Lekki Phase 1, Lagos',
  currency: 'NGN',
  expectedCompletion: '2028-06-30',
  floors: 4,
  unitsPerFloor: 6,
  startFloor: 1,
  namingPattern: '{floor}{index:02}',
  defaultBedrooms: 2,
  defaultSizeSqm: '90.00',
  defaultPrice: '145000000',
  reminderDaysBefore: 7,
  overdueNoticeDaysAfter: 3
}

describe('CreateProjectSchema', () => {
  it('accepts a valid project', () => {
    expect(CreateProjectSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects an unsupported currency', () => {
    expect(CreateProjectSchema.safeParse({ ...valid, currency: 'ZZZ' }).success).toBe(false)
  })

  it('rejects a price with more decimals than the currency allows', () => {
    expect(CreateProjectSchema.safeParse({ ...valid, defaultPrice: '100.999' }).success).toBe(false)
  })

  it('accepts a whole-number price for a zero-decimal currency', () => {
    expect(
      CreateProjectSchema.safeParse({ ...valid, currency: 'RWF', defaultPrice: '95000000' }).success
    ).toBe(true)
  })

  it('rejects a fractional price for a zero-decimal currency', () => {
    expect(
      CreateProjectSchema.safeParse({ ...valid, currency: 'RWF', defaultPrice: '95000000.50' }).success
    ).toBe(false)
  })

  it('rejects a naming pattern that would duplicate names', () => {
    expect(CreateProjectSchema.safeParse({ ...valid, namingPattern: 'Flat {floor}' }).success).toBe(false)
  })

  it('rejects a building larger than 2000 units', () => {
    expect(
      CreateProjectSchema.safeParse({ ...valid, floors: 200, unitsPerFloor: 20 }).success
    ).toBe(false)
  })

  it('rejects zero floors', () => {
    expect(CreateProjectSchema.safeParse({ ...valid, floors: 0 }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- projects
```
Expected: FAIL, `Cannot find module '@/server/services/projects'`.

- [ ] **Step 3: Create the shared service error**

`src/server/services/errors.ts`:
```ts
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'VALIDATION'
      | 'FORBIDDEN' = 'VALIDATION'
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}
```

- [ ] **Step 4: Implement `src/server/services/projects.ts`**

```ts
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { isSupportedCurrency, toMinor } from '@/domain/currency'
import { generateUnitNames } from '@/domain/units'

const MAX_UNITS = 2000

/** Validates that a major-unit string is parseable in the chosen currency. */
function moneyString(field: string) {
  return z.string().min(1, `${field} is required`)
}

export const CreateProjectSchema = z
  .object({
    name: z.string().min(2).max(120),
    location: z.string().min(2).max(200),
    currency: z.string().refine(isSupportedCurrency, 'Unsupported currency'),
    expectedCompletion: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date'),
    floors: z.coerce.number().int().min(1).max(200),
    unitsPerFloor: z.coerce.number().int().min(1).max(100),
    startFloor: z.coerce.number().int().min(0).max(200),
    namingPattern: z.string().min(1),
    defaultBedrooms: z.coerce.number().int().min(0).max(10),
    defaultSizeSqm: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Invalid size'),
    defaultPrice: moneyString('Price'),
    reminderDaysBefore: z.coerce.number().int().min(0).max(60),
    overdueNoticeDaysAfter: z.coerce.number().int().min(0).max(60)
  })
  .superRefine((value, ctx) => {
    if (value.floors * value.unitsPerFloor > MAX_UNITS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unitsPerFloor'],
        message: `A project cannot exceed ${MAX_UNITS} units`
      })
    }

    // Currency-aware price validation: '100.50' is valid NGN but invalid RWF.
    try {
      toMinor(value.defaultPrice, value.currency)
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultPrice'],
        message: error instanceof Error ? error.message : 'Invalid price'
      })
    }

    try {
      generateUnitNames({
        floors: 1,
        unitsPerFloor: 1,
        pattern: value.namingPattern,
        startFloor: value.startFloor
      })
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['namingPattern'],
        message: error instanceof Error ? error.message : 'Invalid pattern'
      })
    }
  })

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>

export async function createProject(actor: SessionActor, input: CreateProjectInput) {
  assertRole(actor, ['ADMIN'])

  const drafts = generateUnitNames({
    floors: input.floors,
    unitsPerFloor: input.unitsPerFloor,
    pattern: input.namingPattern,
    startFloor: input.startFloor
  })

  const priceMinor = toMinor(input.defaultPrice, input.currency)

  // One transaction: a project that half-generated its units is worse than one
  // that failed outright.
  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: {
        orgId: actor.orgId,
        name: input.name,
        location: input.location,
        currency: input.currency.toUpperCase(),
        expectedCompletion: new Date(input.expectedCompletion),
        floors: input.floors,
        unitsPerFloor: input.unitsPerFloor,
        startFloor: input.startFloor,
        namingPattern: input.namingPattern,
        reminderDaysBefore: input.reminderDaysBefore,
        overdueNoticeDaysAfter: input.overdueNoticeDaysAfter
      }
    })

    await tx.unit.createMany({
      data: drafts.map((draft) => ({
        projectId: created.id,
        name: draft.name,
        floor: draft.floor,
        bedrooms: input.defaultBedrooms,
        sizeSqm: input.defaultSizeSqm,
        priceMinor
      }))
    })

    return created
  })

  return { id: project.id, unitCount: drafts.length }
}

export async function listProjects(actor: SessionActor) {
  return prisma.project.findMany({
    where: { orgId: actor.orgId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { units: true } } }
  })
}
```

- [ ] **Step 5: Implement `src/server/services/units.ts`**

```ts
import type { Prisma, UnitStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { toMinor } from '@/domain/currency'

export interface InventoryUnit {
  id: string
  name: string
  floor: number
  bedrooms: number
  sizeSqm: string
  priceMinor: bigint
  status: UnitStatus
}

export interface ProjectInventory {
  project: {
    id: string
    name: string
    location: string
    currency: string
    expectedCompletion: Date
    namingPattern: string
  }
  floors: Array<{ floor: number; units: InventoryUnit[]; available: number; total: number }>
  totals: { total: number; available: number; reserved: number; sold: number }
}

export async function getProjectInventory(
  actor: SessionActor,
  projectId: string
): Promise<ProjectInventory> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId: actor.orgId },
    include: { units: { orderBy: [{ floor: 'asc' }, { name: 'asc' }] } }
  })
  if (!project) throw new ServiceError('Project not found', 'NOT_FOUND')

  const byFloor = new Map<number, InventoryUnit[]>()
  for (const unit of project.units) {
    const entry: InventoryUnit = {
      id: unit.id,
      name: unit.name,
      floor: unit.floor,
      bedrooms: unit.bedrooms,
      sizeSqm: unit.sizeSqm.toString(),
      priceMinor: unit.priceMinor,
      status: unit.status
    }
    byFloor.set(unit.floor, [...(byFloor.get(unit.floor) ?? []), entry])
  }

  const floors = [...byFloor.entries()]
    .sort((a, b) => b[0] - a[0]) // top floor first, as a floor plan reads
    .map(([floor, units]) => ({
      floor,
      units,
      available: units.filter((u) => u.status === 'AVAILABLE').length,
      total: units.length
    }))

  return {
    project: {
      id: project.id,
      name: project.name,
      location: project.location,
      currency: project.currency,
      expectedCompletion: project.expectedCompletion,
      namingPattern: project.namingPattern
    },
    floors,
    totals: {
      total: project.units.length,
      available: project.units.filter((u) => u.status === 'AVAILABLE').length,
      reserved: project.units.filter((u) => u.status === 'RESERVED').length,
      sold: project.units.filter((u) => u.status === 'SOLD').length
    }
  }
}

export const UpdateUnitSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  bedrooms: z.coerce.number().int().min(0).max(10).optional(),
  sizeSqm: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  price: z.string().optional()
})

export async function updateUnit(
  actor: SessionActor,
  unitId: string,
  patch: z.infer<typeof UpdateUnitSchema>
) {
  assertRole(actor, ['ADMIN'])

  const unit = await prisma.unit.findFirst({
    where: { id: unitId, project: { orgId: actor.orgId } },
    include: { project: { select: { currency: true } } }
  })
  if (!unit) throw new ServiceError('Unit not found', 'NOT_FOUND')

  const data: Prisma.UnitUpdateInput = {}
  if (patch.name !== undefined) data.name = patch.name
  if (patch.bedrooms !== undefined) data.bedrooms = patch.bedrooms
  if (patch.sizeSqm !== undefined) data.sizeSqm = patch.sizeSqm
  if (patch.price !== undefined) {
    // Repricing affects new sales only — existing Sale rows hold their own
    // snapshot and are untouched by this.
    data.priceMinor = toMinor(patch.price, unit.project.currency)
  }

  try {
    return await prisma.unit.update({ where: { id: unitId }, data })
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      throw new ServiceError(`Another unit in this project is already named "${patch.name}"`, 'CONFLICT')
    }
    throw error
  }
}

/**
 * Conditional status transition. Returns false when another agent got there
 * first — a zero row count, not a thrown error, because losing the race is an
 * expected outcome rather than a fault.
 */
export async function reserveUnit(
  tx: Prisma.TransactionClient,
  unitId: string,
  to: 'RESERVED' | 'SOLD'
): Promise<boolean> {
  const result = await tx.unit.updateMany({
    where: { id: unitId, status: 'AVAILABLE' },
    data: { status: to }
  })
  return result.count === 1
}
```

- [ ] **Step 6: Run tests and typecheck**

```bash
npm test -- projects
npm run typecheck
```
Expected: PASS, 8 tests; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/server/services src/server/__tests__/projects.test.ts
git commit -m "feat(services): project creation with unit generation and floor inventory"
```

---

### Task 12: Buyer registration, schedule preview, and sale creation

**Files:**
- Create: `src/server/services/sales.ts`
- Test: `src/server/__tests__/sales.test.ts`

**Interfaces:**
- Consumes: `generateSchedule`, `totalScheduledMinor`, `DEFAULT_TERM_MONTHS`, `toMinor`, `reserveUnit`, `prisma`.
- Produces:
  - `BuyerRegistrationSchema`, `PlanSelectionSchema`
  - `previewSchedule(input): { entries: ScheduleEntryDraft[]; totalMinor: bigint; monthlyMinor: bigint | null; finalMinor: bigint | null }` — pure wrapper, no DB
  - `registerBuyer(input): Promise<{ buyerId: string; userId: string }>`
  - `createSale(actor, input): Promise<{ saleId: string }>`
  - `getSaleForStaff(actor, saleId)` and `getSaleForBuyer(actor)` — the buyer form takes **no** sale id, because the sale is looked up from the session's `buyerId`; there is no id to guess
  - `summariseSale(sale, asOf): SaleSummary` where `SaleSummary = { paidToDateMinor: bigint; balanceMinor: bigint; nextDue: { dueDate: Date; amountMinor: bigint } | null; overdueCount: number }`

- [ ] **Step 1: Write the failing tests**

`src/server/__tests__/sales.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { BuyerRegistrationSchema, previewSchedule, summariseSale } from '@/server/services/sales'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

describe('BuyerRegistrationSchema', () => {
  const valid = {
    fullName: 'Amina Yusuf',
    phone: '+2348031234567',
    email: 'amina@example.com',
    address: '14 Admiralty Way, Lekki',
    password: 'password123'
  }

  it('accepts a valid registration', () => {
    expect(BuyerRegistrationSchema.safeParse(valid).success).toBe(true)
  })

  it('accepts a missing address, which is optional', () => {
    const { address, ...withoutAddress } = valid
    expect(BuyerRegistrationSchema.safeParse(withoutAddress).success).toBe(true)
  })

  it('requires full name, phone and email', () => {
    for (const field of ['fullName', 'phone', 'email'] as const) {
      const copy: Record<string, unknown> = { ...valid }
      delete copy[field]
      expect(BuyerRegistrationSchema.safeParse(copy).success, field).toBe(false)
    }
  })

  it('requires E.164 phone format with a country code', () => {
    for (const phone of ['08031234567', '2348031234567', '+234 803 123 4567', '+0803123', 'phone']) {
      expect(BuyerRegistrationSchema.safeParse({ ...valid, phone }).success, phone).toBe(false)
    }
  })

  it('accepts E.164 numbers from several African countries', () => {
    for (const phone of ['+2348031234567', '+254712345678', '+233201234567', '+27821234567', '+250788123456']) {
      expect(BuyerRegistrationSchema.safeParse({ ...valid, phone }).success, phone).toBe(true)
    }
  })

  it('lowercases the email', () => {
    const parsed = BuyerRegistrationSchema.parse({ ...valid, email: 'Amina@Example.COM' })
    expect(parsed.email).toBe('amina@example.com')
  })
})

describe('previewSchedule', () => {
  it('summarises an installment plan without touching the database', () => {
    const preview = previewSchedule({
      planType: 'INSTALLMENTS',
      priceMinor: 100_000n,
      depositMinor: 0n,
      months: 36,
      signedAt: utc(2026, 8, 9)
    })

    expect(preview.entries).toHaveLength(36)
    expect(preview.monthlyMinor).toBe(2_777n)
    expect(preview.finalMinor).toBe(2_805n)
    expect(preview.totalMinor).toBe(100_000n)
  })

  it('reports no monthly figure for a full payment', () => {
    const preview = previewSchedule({
      planType: 'FULL',
      priceMinor: 100_000n,
      depositMinor: 0n,
      months: 0,
      signedAt: utc(2026, 8, 9)
    })

    expect(preview.entries).toHaveLength(1)
    expect(preview.monthlyMinor).toBeNull()
    expect(preview.totalMinor).toBe(100_000n)
  })
})

describe('summariseSale', () => {
  const sale = {
    priceMinor: 900n,
    depositMinor: 0n,
    scheduleEntries: [
      { dueDate: utc(2026, 6, 9), amountDueMinor: 300n, amountPaidMinor: 300n },
      { dueDate: utc(2026, 7, 9), amountDueMinor: 300n, amountPaidMinor: 100n },
      { dueDate: utc(2026, 8, 9), amountDueMinor: 300n, amountPaidMinor: 0n }
    ]
  }

  it('totals what has been paid and what remains', () => {
    const summary = summariseSale(sale, utc(2026, 7, 20))
    expect(summary.paidToDateMinor).toBe(400n)
    expect(summary.balanceMinor).toBe(500n)
  })

  it('counts the deposit as paid to date', () => {
    const summary = summariseSale({ ...sale, depositMinor: 250n }, utc(2026, 7, 20))
    expect(summary.paidToDateMinor).toBe(650n)
  })

  it('reports the oldest unsettled entry as next due', () => {
    const summary = summariseSale(sale, utc(2026, 7, 20))
    expect(summary.nextDue?.dueDate.toISOString().slice(0, 10)).toBe('2026-07-09')
    expect(summary.nextDue?.amountMinor).toBe(200n)
  })

  it('counts overdue entries as of the given date', () => {
    expect(summariseSale(sale, utc(2026, 7, 20)).overdueCount).toBe(1)
    expect(summariseSale(sale, utc(2026, 9, 20)).overdueCount).toBe(2)
    expect(summariseSale(sale, utc(2026, 6, 1)).overdueCount).toBe(0)
  })

  it('reports no next due date once everything is settled', () => {
    const settled = {
      priceMinor: 300n,
      depositMinor: 0n,
      scheduleEntries: [{ dueDate: utc(2026, 6, 9), amountDueMinor: 300n, amountPaidMinor: 300n }]
    }
    const summary = summariseSale(settled, utc(2026, 12, 1))
    expect(summary.nextDue).toBeNull()
    expect(summary.balanceMinor).toBe(0n)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- sales
```
Expected: FAIL, `Cannot find module '@/server/services/sales'`.

- [ ] **Step 3: Implement `src/server/services/sales.ts`**

```ts
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { reserveUnit } from '@/server/services/units'
import { toMinor } from '@/domain/currency'
import {
  DEFAULT_TERM_MONTHS,
  generateSchedule,
  totalScheduledMinor,
  type PlanType,
  type ScheduleEntryDraft,
  type ScheduleInput
} from '@/domain/schedule'
import { deriveStatus, outstandingMinor } from '@/domain/status'

export { DEFAULT_TERM_MONTHS }

/**
 * E.164: a leading +, a non-zero country code digit, then up to 14 more digits.
 * No spaces or separators are stored, so the same number is never recorded two
 * ways — which matters when SMS delivery is added later.
 */
const E164 = /^\+[1-9]\d{7,14}$/

export const BuyerRegistrationSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name is required').max(120),
  phone: z
    .string()
    .trim()
    .regex(E164, 'Enter your phone number with country code, e.g. +2348031234567'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  address: z.string().trim().max(300).optional(),
  password: z.string().min(8, 'Use at least 8 characters')
})

export type BuyerRegistrationInput = z.infer<typeof BuyerRegistrationSchema>

export const PlanSelectionSchema = z
  .object({
    unitId: z.string().min(1),
    planType: z.enum(['FULL', 'INSTALLMENTS']),
    deposit: z.string().default('0'),
    termMonths: z.coerce.number().int().min(1).max(360).default(DEFAULT_TERM_MONTHS)
  })
  .transform((value) => (value.planType === 'FULL' ? { ...value, deposit: '0' } : value))

export interface SchedulePreview {
  entries: ScheduleEntryDraft[]
  totalMinor: bigint
  monthlyMinor: bigint | null
  finalMinor: bigint | null
}

/** Pure wrapper — no database access, so the UI can preview before committing. */
export function previewSchedule(input: ScheduleInput): SchedulePreview {
  const entries = generateSchedule(input)
  const isInstallments = input.planType === 'INSTALLMENTS'

  return {
    entries,
    totalMinor: totalScheduledMinor(entries),
    monthlyMinor: isInstallments ? entries[0].amountDueMinor : null,
    finalMinor: isInstallments ? entries[entries.length - 1].amountDueMinor : null
  }
}

export interface SaleSummary {
  paidToDateMinor: bigint
  balanceMinor: bigint
  nextDue: { dueDate: Date; amountMinor: bigint } | null
  overdueCount: number
}

export function summariseSale(
  sale: {
    priceMinor: bigint
    depositMinor: bigint
    scheduleEntries: Array<{ dueDate: Date; amountDueMinor: bigint; amountPaidMinor: bigint }>
  },
  asOf: Date
): SaleSummary {
  const entries = [...sale.scheduleEntries].sort(
    (a, b) => a.dueDate.getTime() - b.dueDate.getTime()
  )

  const allocatedMinor = entries.reduce((sum, e) => sum + e.amountPaidMinor, 0n)
  const paidToDateMinor = sale.depositMinor + allocatedMinor
  const balanceMinor = sale.priceMinor - paidToDateMinor

  const next = entries.find((e) => outstandingMinor(e) > 0n)

  return {
    paidToDateMinor,
    balanceMinor: balanceMinor > 0n ? balanceMinor : 0n,
    nextDue: next ? { dueDate: next.dueDate, amountMinor: outstandingMinor(next) } : null,
    overdueCount: entries.filter((e) => deriveStatus(e, asOf) === 'OVERDUE').length
  }
}

export async function registerBuyer(orgId: string, input: BuyerRegistrationInput) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } })
  if (existing) {
    throw new ServiceError('An account with that email already exists. Please sign in.', 'CONFLICT')
  }

  const passwordHash = await bcrypt.hash(input.password, 10)

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        orgId,
        email: input.email,
        passwordHash,
        fullName: input.fullName,
        role: 'BUYER'
      }
    })

    const buyer = await tx.buyer.create({
      data: {
        orgId,
        userId: user.id,
        fullName: input.fullName,
        phone: input.phone,
        email: input.email,
        address: input.address ?? null
      }
    })

    return { buyerId: buyer.id, userId: user.id }
  })
}

export async function createSale(
  actor: SessionActor,
  input: {
    buyerId: string
    unitId: string
    planType: PlanType
    deposit: string
    termMonths: number
    signedAt: Date
  }
) {
  const unit = await prisma.unit.findFirst({
    where: { id: input.unitId, project: { orgId: actor.orgId } },
    include: { project: { select: { id: true, currency: true } } }
  })
  if (!unit) throw new ServiceError('Unit not found', 'NOT_FOUND')
  if (unit.status !== 'AVAILABLE') {
    throw new ServiceError('That unit is no longer available', 'CONFLICT')
  }

  const buyer = await prisma.buyer.findFirst({
    where: { id: input.buyerId, orgId: actor.orgId }
  })
  if (!buyer) throw new ServiceError('Buyer not found', 'NOT_FOUND')

  const depositMinor = toMinor(input.deposit, unit.project.currency)
  const drafts = generateSchedule({
    planType: input.planType,
    priceMinor: unit.priceMinor,
    depositMinor,
    months: input.termMonths,
    signedAt: input.signedAt
  })

  return prisma.$transaction(async (tx) => {
    // Conditional claim inside the transaction. Two agents pressing Confirm at
    // the same moment: one wins, the other gets a clean message.
    const claimed = await reserveUnit(tx, unit.id, 'SOLD')
    if (!claimed) throw new ServiceError('That unit was just taken by someone else', 'CONFLICT')

    const sale = await tx.sale.create({
      data: {
        orgId: actor.orgId,
        projectId: unit.project.id,
        unitId: unit.id,
        buyerId: buyer.id,
        planType: input.planType,
        // Snapshotted: repricing the unit later must not alter this contract.
        priceMinor: unit.priceMinor,
        depositMinor,
        currency: unit.project.currency,
        termMonths: input.planType === 'INSTALLMENTS' ? input.termMonths : null,
        signedAt: input.signedAt,
        createdByUserId: actor.userId,
        scheduleEntries: { create: drafts }
      }
    })

    return { saleId: sale.id }
  })
}

const saleInclude = {
  unit: { select: { id: true, name: true, floor: true, bedrooms: true, sizeSqm: true } },
  project: { select: { id: true, name: true, location: true, currency: true } },
  buyer: { select: { id: true, fullName: true, phone: true, email: true, address: true } },
  scheduleEntries: { orderBy: { sequence: 'asc' } },
  payments: {
    orderBy: { receivedAt: 'desc' },
    include: { allocations: true, document: true }
  },
  documents: true
} as const

export async function getSaleForStaff(actor: SessionActor, saleId: string) {
  assertRole(actor, ['ADMIN', 'AGENT'])
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, orgId: actor.orgId },
    include: saleInclude
  })
  if (!sale) throw new ServiceError('Sale not found', 'NOT_FOUND')
  return sale
}

export async function getSaleForBuyer(actor: SessionActor & { buyerId: string }) {
  // Scoped by buyerId from the session, never from a route parameter — a guessed
  // URL returns nothing rather than someone else's contract.
  const sale = await prisma.sale.findFirst({
    where: { buyerId: actor.buyerId, orgId: actor.orgId, status: { not: 'CANCELLED' } },
    orderBy: { createdAt: 'desc' },
    include: saleInclude
  })
  return sale
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
npm test -- sales
npm run typecheck
```
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/sales.ts src/server/__tests__/sales.test.ts
git commit -m "feat(services): buyer registration, schedule preview, and race-safe sale creation"
```

---

### Task 13: Recording and voiding payments

**Files:**
- Create: `src/server/services/payments.ts`
- Test: `src/server/__tests__/payments.test.ts`

**Interfaces:**
- Consumes: `allocatePayment` from `@/domain/allocation`, `prisma`, `ServiceError`.
- Produces:
  - `RecordPaymentSchema`
  - `recordPayment(actor, input): Promise<{ paymentId: string; overpaymentMinor: bigint; settledEntryIds: string[] }>`
  - `voidPayment(actor, paymentId, reason): Promise<void>`
  - `applyAllocations(tx, ...)` — internal, exported for reuse by the seed

- [ ] **Step 1: Write the failing test**

`src/server/__tests__/payments.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { RecordPaymentSchema } from '@/server/services/payments'

const valid = {
  saleId: 'sale_1',
  amount: '250000',
  receivedAt: '2026-08-09',
  method: 'BANK_TRANSFER',
  reference: 'GTB/2026/08/0021',
  note: ''
}

describe('RecordPaymentSchema', () => {
  it('accepts a valid payment', () => {
    expect(RecordPaymentSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects a zero or negative amount', () => {
    expect(RecordPaymentSchema.safeParse({ ...valid, amount: '0' }).success).toBe(false)
    expect(RecordPaymentSchema.safeParse({ ...valid, amount: '-100' }).success).toBe(false)
  })

  it('rejects a non-numeric amount', () => {
    expect(RecordPaymentSchema.safeParse({ ...valid, amount: 'lots' }).success).toBe(false)
  })

  it('rejects an unknown payment method', () => {
    expect(RecordPaymentSchema.safeParse({ ...valid, method: 'CRYPTO' }).success).toBe(false)
  })

  it('accepts every supported method', () => {
    for (const method of ['BANK_TRANSFER', 'MOBILE_MONEY', 'CASH', 'CHEQUE', 'OTHER']) {
      expect(RecordPaymentSchema.safeParse({ ...valid, method }).success, method).toBe(true)
    }
  })

  it('allows an omitted reference for cash', () => {
    const { reference, ...withoutReference } = valid
    expect(
      RecordPaymentSchema.safeParse({ ...withoutReference, method: 'CASH' }).success
    ).toBe(true)
  })

  it('rejects an invalid date', () => {
    expect(RecordPaymentSchema.safeParse({ ...valid, receivedAt: 'yesterday' }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- payments
```
Expected: FAIL, `Cannot find module '@/server/services/payments'`.

- [ ] **Step 3: Implement `src/server/services/payments.ts`**

```ts
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { allocatePayment, type Allocation } from '@/domain/allocation'
import { toMinor } from '@/domain/currency'

export const RecordPaymentSchema = z.object({
  saleId: z.string().min(1),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Enter a valid amount').refine(
    (v) => Number(v) > 0,
    'Amount must be greater than zero'
  ),
  receivedAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date'),
  method: z.enum(['BANK_TRANSFER', 'MOBILE_MONEY', 'CASH', 'CHEQUE', 'OTHER']),
  reference: z.string().trim().max(80).optional(),
  note: z.string().trim().max(500).optional()
})

export type RecordPaymentInput = z.infer<typeof RecordPaymentSchema>

/**
 * Writes allocations and recomputes each touched entry's amountPaidMinor from
 * its allocation rows — recomputed, not incremented, so a retry or a concurrent
 * write cannot leave the cached total disagreeing with the audit trail.
 */
async function applyAllocations(
  tx: Prisma.TransactionClient,
  paymentId: string,
  allocations: Allocation[],
  receivedAt: Date
): Promise<string[]> {
  const settled: string[] = []

  for (const allocation of allocations) {
    await tx.paymentAllocation.create({
      data: {
        paymentId,
        scheduleEntryId: allocation.entryId,
        amountMinor: allocation.amountMinor
      }
    })

    const rows = await tx.paymentAllocation.findMany({
      where: { scheduleEntryId: allocation.entryId, payment: { voidedAt: null } },
      select: { amountMinor: true }
    })
    const total = rows.reduce((sum, row) => sum + row.amountMinor, 0n)

    const entry = await tx.scheduleEntry.findUniqueOrThrow({
      where: { id: allocation.entryId },
      select: { amountDueMinor: true }
    })

    const fullySettled = total >= entry.amountDueMinor
    await tx.scheduleEntry.update({
      where: { id: allocation.entryId },
      data: { amountPaidMinor: total, paidAt: fullySettled ? receivedAt : null }
    })

    if (fullySettled) settled.push(allocation.entryId)
  }

  return settled
}

export async function recordPayment(actor: SessionActor, input: RecordPaymentInput) {
  assertRole(actor, ['ADMIN', 'AGENT'])

  const sale = await prisma.sale.findFirst({
    where: { id: input.saleId, orgId: actor.orgId },
    select: { id: true, currency: true }
  })
  if (!sale) throw new ServiceError('Sale not found', 'NOT_FOUND')

  const amountMinor = toMinor(input.amount, sale.currency)
  const receivedAt = new Date(input.receivedAt)

  return prisma.$transaction(async (tx) => {
    const entries = await tx.scheduleEntry.findMany({
      where: { saleId: sale.id },
      orderBy: { sequence: 'asc' },
      select: { id: true, sequence: true, amountDueMinor: true, amountPaidMinor: true }
    })

    const { allocations, overpaymentMinor } = allocatePayment(entries, amountMinor)

    const payment = await tx.payment.create({
      data: {
        orgId: actor.orgId,
        saleId: sale.id,
        amountMinor,
        receivedAt,
        method: input.method,
        reference: input.reference || null,
        note: input.note || null,
        recordedByUserId: actor.userId
      }
    })

    const settledEntryIds = await applyAllocations(tx, payment.id, allocations, receivedAt)

    // Close the sale once nothing is outstanding. Compared in JS rather than
    // via a Prisma field reference — comparing two columns of the same row is
    // awkward in Prisma, and a schedule is at most a few hundred rows.
    const afterEntries = await tx.scheduleEntry.findMany({
      where: { saleId: sale.id },
      select: { amountDueMinor: true, amountPaidMinor: true }
    })
    if (afterEntries.every((e) => e.amountPaidMinor >= e.amountDueMinor)) {
      await tx.sale.update({ where: { id: sale.id }, data: { status: 'COMPLETED' } })
    }

    return { paymentId: payment.id, overpaymentMinor, settledEntryIds }
  })
}

export async function voidPayment(actor: SessionActor, paymentId: string, reason: string) {
  // Voiding rewrites balances, so it is ADMIN-only.
  assertRole(actor, ['ADMIN'])
  if (!reason.trim()) throw new ServiceError('A reason is required to void a payment')

  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, orgId: actor.orgId },
    include: { allocations: { select: { scheduleEntryId: true } } }
  })
  if (!payment) throw new ServiceError('Payment not found', 'NOT_FOUND')
  if (payment.voidedAt) throw new ServiceError('That payment is already void', 'CONFLICT')

  const affectedEntryIds = payment.allocations.map((a) => a.scheduleEntryId)

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: paymentId },
      data: { voidedAt: new Date(), voidedByUserId: actor.userId, voidReason: reason.trim() }
    })

    // The payment row survives for audit; only its allocations are withdrawn.
    await tx.paymentAllocation.deleteMany({ where: { paymentId } })

    for (const entryId of affectedEntryIds) {
      const rows = await tx.paymentAllocation.findMany({
        where: { scheduleEntryId: entryId, payment: { voidedAt: null } },
        select: { amountMinor: true }
      })
      const total = rows.reduce((sum, row) => sum + row.amountMinor, 0n)
      const entry = await tx.scheduleEntry.findUniqueOrThrow({
        where: { id: entryId },
        select: { amountDueMinor: true }
      })

      await tx.scheduleEntry.update({
        where: { id: entryId },
        data: {
          amountPaidMinor: total,
          paidAt: total >= entry.amountDueMinor ? undefined : null
        }
      })
    }

    await tx.sale.update({ where: { id: payment.saleId }, data: { status: 'ACTIVE' } })
  })
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- payments
npm run typecheck
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Manually verify allocation against the seeded database**

```bash
npx tsx -e "import{prisma}from'./src/server/db';prisma.scheduleEntry.findMany({where:{sale:{buyer:{email:'zainab@buyer.test'}}},orderBy:{sequence:'asc'},take:3,select:{sequence:true,amountDueMinor:true,amountPaidMinor:true}}).then(r=>console.table(r.map(x=>({...x,amountDueMinor:String(x.amountDueMinor),amountPaidMinor:String(x.amountPaidMinor)}))))"
```
Expected: entry 1 fully paid, entry 2 partially paid, entry 3 untouched — confirming cascade behaviour against real rows.

- [ ] **Step 6: Commit**

```bash
git add src/server/services/payments.ts src/server/__tests__/payments.test.ts
git commit -m "feat(services): payment recording with recomputed allocations and admin void"
```

---

### Task 14: Arrears report

**Files:**
- Create: `src/server/services/arrears.ts`
- Test: `src/server/__tests__/arrears.test.ts`

**Interfaces:**
- Consumes: `prisma`, `deriveStatus`, `daysLate`, `outstandingMinor`.
- Produces:
  - `interface ArrearsRow { saleId: string; buyerName: string; buyerPhone: string; buyerEmail: string; projectName: string; unitName: string; currency: string; overdueCount: number; overdueAmountMinor: bigint; oldestDueDate: Date; daysLate: number }`
  - `arrearsReport(actor, asOf): Promise<ArrearsRow[]>`
  - `buildArrearsRows(sales, asOf): ArrearsRow[]` — pure, unit tested

- [ ] **Step 1: Write the failing test**

`src/server/__tests__/arrears.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildArrearsRows } from '@/server/services/arrears'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

const sale = (id: string, entries: Array<[Date, bigint, bigint]>) => ({
  id,
  currency: 'KES',
  buyer: { fullName: `Buyer ${id}`, phone: '+254712345678', email: `${id}@example.com` },
  project: { name: 'Riverside Court' },
  unit: { name: '4C' },
  scheduleEntries: entries.map(([dueDate, amountDueMinor, amountPaidMinor]) => ({
    dueDate,
    amountDueMinor,
    amountPaidMinor
  }))
})

describe('buildArrearsRows', () => {
  const asOf = utc(2026, 8, 9)

  it('lists a buyer with overdue entries', () => {
    const rows = buildArrearsRows(
      [sale('a', [[utc(2026, 6, 10), 300n, 0n], [utc(2026, 7, 10), 300n, 100n]])],
      asOf
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].overdueCount).toBe(2)
    expect(rows[0].overdueAmountMinor).toBe(500n)
    expect(rows[0].daysLate).toBe(60)
    expect(rows[0].oldestDueDate.toISOString().slice(0, 10)).toBe('2026-06-10')
  })

  it('excludes buyers with nothing overdue', () => {
    expect(
      buildArrearsRows([sale('b', [[utc(2026, 9, 10), 300n, 0n]])], asOf)
    ).toEqual([])
  })

  it('excludes fully paid past entries', () => {
    expect(
      buildArrearsRows([sale('c', [[utc(2026, 6, 10), 300n, 300n]])], asOf)
    ).toEqual([])
  })

  it('does not count an entry due today as overdue', () => {
    expect(buildArrearsRows([sale('d', [[asOf, 300n, 0n]])], asOf)).toEqual([])
  })

  it('sorts the most delinquent buyer first', () => {
    const rows = buildArrearsRows(
      [
        sale('recent', [[utc(2026, 7, 10), 300n, 0n]]),
        sale('oldest', [[utc(2026, 2, 10), 300n, 0n]]),
        sale('middle', [[utc(2026, 5, 10), 300n, 0n]])
      ],
      asOf
    )
    expect(rows.map((r) => r.saleId)).toEqual(['oldest', 'middle', 'recent'])
  })

  it('carries contact details for follow-up', () => {
    const rows = buildArrearsRows([sale('e', [[utc(2026, 6, 10), 300n, 0n]])], asOf)
    expect(rows[0].buyerPhone).toBe('+254712345678')
    expect(rows[0].currency).toBe('KES')
    expect(rows[0].unitName).toBe('4C')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- arrears
```
Expected: FAIL, `Cannot find module '@/server/services/arrears'`.

- [ ] **Step 3: Implement `src/server/services/arrears.ts`**

```ts
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { daysLate, deriveStatus, outstandingMinor } from '@/domain/status'

export interface ArrearsRow {
  saleId: string
  buyerName: string
  buyerPhone: string
  buyerEmail: string
  projectName: string
  unitName: string
  currency: string
  overdueCount: number
  overdueAmountMinor: bigint
  oldestDueDate: Date
  daysLate: number
}

interface ArrearsSale {
  id: string
  currency: string
  buyer: { fullName: string; phone: string; email: string }
  project: { name: string }
  unit: { name: string }
  scheduleEntries: Array<{ dueDate: Date; amountDueMinor: bigint; amountPaidMinor: bigint }>
}

/** Pure: takes sales, returns rows. Sorted worst-first. */
export function buildArrearsRows(sales: ArrearsSale[], asOf: Date): ArrearsRow[] {
  const rows: ArrearsRow[] = []

  for (const sale of sales) {
    const overdue = sale.scheduleEntries.filter((e) => deriveStatus(e, asOf) === 'OVERDUE')
    if (overdue.length === 0) continue

    const oldest = overdue.reduce((a, b) => (a.dueDate <= b.dueDate ? a : b))

    rows.push({
      saleId: sale.id,
      buyerName: sale.buyer.fullName,
      buyerPhone: sale.buyer.phone,
      buyerEmail: sale.buyer.email,
      projectName: sale.project.name,
      unitName: sale.unit.name,
      currency: sale.currency,
      overdueCount: overdue.length,
      overdueAmountMinor: overdue.reduce((sum, e) => sum + outstandingMinor(e), 0n),
      oldestDueDate: oldest.dueDate,
      daysLate: daysLate(oldest, asOf)
    })
  }

  return rows.sort((a, b) => b.daysLate - a.daysLate)
}

export async function arrearsReport(actor: SessionActor, asOf: Date): Promise<ArrearsRow[]> {
  assertRole(actor, ['ADMIN', 'AGENT'])

  // Narrow in SQL first — only sales with at least one past-due unsettled entry
  // reach the pure function. Status is derived, so this filter is the query.
  const sales = await prisma.sale.findMany({
    where: {
      orgId: actor.orgId,
      status: 'ACTIVE',
      scheduleEntries: { some: { dueDate: { lt: asOf } } }
    },
    select: {
      id: true,
      currency: true,
      buyer: { select: { fullName: true, phone: true, email: true } },
      project: { select: { name: true } },
      unit: { select: { name: true } },
      scheduleEntries: {
        select: { dueDate: true, amountDueMinor: true, amountPaidMinor: true }
      }
    }
  })

  return buildArrearsRows(sales, asOf)
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- arrears
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/arrears.ts src/server/__tests__/arrears.test.ts
git commit -m "feat(services): arrears report with pure row building"
```

---

### Task 15: PDF invoices, receipts and statements

**Files:**
- Create: `src/server/documents/numbering.ts`, `src/server/documents/issue.ts`, `src/server/pdf/styles.ts`, `src/server/pdf/InvoiceDocument.tsx`, `src/server/pdf/ReceiptDocument.tsx`, `src/server/pdf/StatementDocument.tsx`, `src/server/pdf/render.tsx`, `src/app/api/documents/[id]/route.ts`
- Test: `src/server/__tests__/numbering.test.ts`

**Interfaces:**
- Consumes: `prisma`, `formatMinor`, `deriveStatus`, `summariseSale`.
- Produces:
  - `formatDocumentNumber(type: DocumentType, sequence: number): string` — pure
  - `issueInvoice(actor, scheduleEntryId): Promise<{ documentId: string }>`
  - `issueReceipt(tx, orgId, saleId, paymentId): Promise<{ documentId: string }>`
  - `issueStatement(actor, saleId): Promise<{ documentId: string }>`
  - `renderDocumentPdf(documentId, orgId): Promise<Buffer>`

- [ ] **Step 1: Write the failing test for numbering**

`src/server/__tests__/numbering.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { formatDocumentNumber } from '@/server/documents/numbering'

describe('formatDocumentNumber', () => {
  it('prefixes by type and pads to six digits', () => {
    expect(formatDocumentNumber('INVOICE', 1)).toBe('INV-000001')
    expect(formatDocumentNumber('RECEIPT', 42)).toBe('RCP-000042')
    expect(formatDocumentNumber('STATEMENT', 999_999)).toBe('STM-999999')
  })

  it('does not truncate beyond the padding width', () => {
    expect(formatDocumentNumber('INVOICE', 1_000_000)).toBe('INV-1000000')
  })

  it('rejects a non-positive sequence', () => {
    expect(() => formatDocumentNumber('INVOICE', 0)).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run to verify it fails, then implement numbering**

```bash
npm test -- numbering
```
Expected: FAIL.

`src/server/documents/numbering.ts`:
```ts
import type { DocumentType, Prisma } from '@prisma/client'

const PREFIX: Record<DocumentType, string> = {
  INVOICE: 'INV',
  RECEIPT: 'RCP',
  STATEMENT: 'STM'
}

export function formatDocumentNumber(type: DocumentType, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`sequence must be a positive integer, received ${sequence}`)
  }
  return `${PREFIX[type]}-${String(sequence).padStart(6, '0')}`
}

/**
 * Atomically claims the next number for an organisation. The increment and the
 * read happen in one statement, so two documents issued at the same instant
 * cannot receive the same number.
 */
export async function nextDocumentSequence(
  tx: Prisma.TransactionClient,
  orgId: string
): Promise<number> {
  const org = await tx.organization.update({
    where: { id: orgId },
    data: { documentSeq: { increment: 1 } },
    select: { documentSeq: true }
  })
  return org.documentSeq
}
```

- [ ] **Step 3: Implement document issuing**

`src/server/documents/issue.ts`:
```ts
import type { DocumentType, Prisma } from '@prisma/client'
import { prisma } from '@/server/db'
import { type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { formatDocumentNumber, nextDocumentSequence } from '@/server/documents/numbering'

async function createDocument(
  tx: Prisma.TransactionClient,
  args: {
    orgId: string
    saleId: string
    type: DocumentType
    scheduleEntryId?: string
    paymentId?: string
  }
) {
  const sequence = await nextDocumentSequence(tx, args.orgId)
  return tx.document.create({
    data: {
      orgId: args.orgId,
      saleId: args.saleId,
      type: args.type,
      number: formatDocumentNumber(args.type, sequence),
      sequence,
      scheduleEntryId: args.scheduleEntryId ?? null,
      paymentId: args.paymentId ?? null
    }
  })
}

/** Idempotent: a second request for the same installment returns the first invoice. */
export async function issueInvoice(actor: SessionActor, scheduleEntryId: string) {
  const entry = await prisma.scheduleEntry.findFirst({
    where: { id: scheduleEntryId, sale: { orgId: actor.orgId } },
    include: { sale: { select: { id: true } }, documents: true }
  })
  if (!entry) throw new ServiceError('Installment not found', 'NOT_FOUND')

  const existing = entry.documents.find((d) => d.type === 'INVOICE')
  if (existing) return { documentId: existing.id }

  const doc = await prisma.$transaction((tx) =>
    createDocument(tx, {
      orgId: actor.orgId,
      saleId: entry.sale.id,
      type: 'INVOICE',
      scheduleEntryId: entry.id
    })
  )
  return { documentId: doc.id }
}

/** Called inside the payment transaction, so a receipt always exists for a payment. */
export async function issueReceipt(
  tx: Prisma.TransactionClient,
  orgId: string,
  saleId: string,
  paymentId: string
) {
  const doc = await createDocument(tx, { orgId, saleId, type: 'RECEIPT', paymentId })
  return { documentId: doc.id }
}

export async function issueStatement(actor: SessionActor, saleId: string) {
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, orgId: actor.orgId },
    include: { documents: { where: { type: 'STATEMENT' } } }
  })
  if (!sale) throw new ServiceError('Sale not found', 'NOT_FOUND')
  if (sale.documents[0]) return { documentId: sale.documents[0].id }

  const doc = await prisma.$transaction((tx) =>
    createDocument(tx, { orgId: actor.orgId, saleId: sale.id, type: 'STATEMENT' })
  )
  return { documentId: doc.id }
}
```

- [ ] **Step 4: Wire receipt issuing into `recordPayment`**

In `src/server/services/payments.ts`, add the import and issue the receipt inside the existing transaction, immediately after `applyAllocations`:

```ts
import { issueReceipt } from '@/server/documents/issue'
```

```ts
    const settledEntryIds = await applyAllocations(tx, payment.id, allocations, receivedAt)
    const { documentId: receiptId } = await issueReceipt(tx, actor.orgId, sale.id, payment.id)
```

and extend the return value:

```ts
    return { paymentId: payment.id, receiptId, overpaymentMinor, settledEntryIds }
```

- [ ] **Step 5: Implement the PDF documents**

`src/server/pdf/styles.ts`:
```ts
import { StyleSheet } from '@react-pdf/renderer'

export const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: 'Helvetica', color: '#0f172a' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  orgName: { fontSize: 16, fontFamily: 'Helvetica-Bold' },
  docTitle: { fontSize: 14, fontFamily: 'Helvetica-Bold', textAlign: 'right' },
  muted: { color: '#64748b' },
  section: { marginBottom: 16 },
  label: { color: '#64748b', marginBottom: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
    paddingBottom: 4,
    marginBottom: 4,
    fontFamily: 'Helvetica-Bold'
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: '#e2e8f0'
  },
  colSeq: { width: '10%' },
  colDate: { width: '25%' },
  colAmount: { width: '25%', textAlign: 'right' },
  colPaid: { width: '20%', textAlign: 'right' },
  colStatus: { width: '20%', textAlign: 'right' },
  total: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, fontFamily: 'Helvetica-Bold' },
  void: { color: '#b91c1c', fontFamily: 'Helvetica-Bold', marginTop: 8 },
  footer: { position: 'absolute', bottom: 24, left: 36, right: 36, fontSize: 8, color: '#94a3b8' }
})
```

`src/server/pdf/InvoiceDocument.tsx`:
```tsx
import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import { formatMinor } from '@/domain/currency'

export interface InvoiceProps {
  number: string
  issuedAt: Date
  orgName: string
  projectName: string
  unitName: string
  buyerName: string
  buyerPhone: string
  buyerEmail: string
  currency: string
  sequence: number
  totalInstallments: number
  dueDate: Date
  amountDueMinor: bigint
  amountPaidMinor: bigint
}

const date = (d: Date) => d.toISOString().slice(0, 10)

export function InvoiceDocument(props: InvoiceProps) {
  const outstanding = props.amountDueMinor - props.amountPaidMinor

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.orgName}>{props.orgName}</Text>
            <Text style={styles.muted}>{props.projectName}</Text>
          </View>
          <View>
            <Text style={styles.docTitle}>INVOICE</Text>
            <Text style={styles.muted}>{props.number}</Text>
            <Text style={styles.muted}>Issued {date(props.issuedAt)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Billed to</Text>
          <Text>{props.buyerName}</Text>
          <Text style={styles.muted}>{props.buyerPhone}</Text>
          <Text style={styles.muted}>{props.buyerEmail}</Text>
        </View>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.label}>Unit</Text>
            <Text>{props.unitName}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Installment</Text>
            <Text>
              {props.sequence} of {props.totalInstallments}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Due date</Text>
            <Text>{date(props.dueDate)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text>Installment amount</Text>
            <Text>{formatMinor(props.amountDueMinor, props.currency)}</Text>
          </View>
          <View style={styles.row}>
            <Text>Already paid</Text>
            <Text>{formatMinor(props.amountPaidMinor, props.currency)}</Text>
          </View>
          <View style={styles.total}>
            <Text>Amount due</Text>
            <Text>{formatMinor(outstanding > 0n ? outstanding : 0n, props.currency)}</Text>
          </View>
        </View>

        <Text style={styles.footer}>
          {props.orgName} · Invoice {props.number} · Please quote this number with your payment.
        </Text>
      </Page>
    </Document>
  )
}
```

`src/server/pdf/ReceiptDocument.tsx`:
```tsx
import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import { formatMinor } from '@/domain/currency'

export interface ReceiptProps {
  number: string
  orgName: string
  projectName: string
  unitName: string
  buyerName: string
  currency: string
  amountMinor: bigint
  receivedAt: Date
  method: string
  reference: string | null
  allocations: Array<{ sequence: number; dueDate: Date; amountMinor: bigint }>
  balanceMinor: bigint
  voided: boolean
  voidReason: string | null
}

const date = (d: Date) => d.toISOString().slice(0, 10)
const methodLabel = (m: string) => m.replace(/_/g, ' ').toLowerCase()

export function ReceiptDocument(props: ReceiptProps) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.orgName}>{props.orgName}</Text>
            <Text style={styles.muted}>{props.projectName}</Text>
          </View>
          <View>
            <Text style={styles.docTitle}>RECEIPT</Text>
            <Text style={styles.muted}>{props.number}</Text>
          </View>
        </View>

        {props.voided ? (
          <Text style={styles.void}>VOID — {props.voidReason ?? 'this payment was reversed'}</Text>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.label}>Received from</Text>
          <Text>{props.buyerName}</Text>
          <Text style={styles.muted}>Unit {props.unitName}</Text>
        </View>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.label}>Date received</Text>
            <Text>{date(props.receivedAt)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Method</Text>
            <Text>{methodLabel(props.method)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Reference</Text>
            <Text>{props.reference ?? '—'}</Text>
          </View>
          <View style={styles.total}>
            <Text>Amount received</Text>
            <Text>{formatMinor(props.amountMinor, props.currency)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Applied to</Text>
          <View style={styles.tableHeader}>
            <Text style={styles.colSeq}>#</Text>
            <Text style={styles.colDate}>Due date</Text>
            <Text style={styles.colAmount}>Applied</Text>
          </View>
          {props.allocations.map((a) => (
            <View key={a.sequence} style={styles.tableRow}>
              <Text style={styles.colSeq}>{a.sequence}</Text>
              <Text style={styles.colDate}>{date(a.dueDate)}</Text>
              <Text style={styles.colAmount}>{formatMinor(a.amountMinor, props.currency)}</Text>
            </View>
          ))}
          <View style={styles.total}>
            <Text>Balance remaining</Text>
            <Text>{formatMinor(props.balanceMinor, props.currency)}</Text>
          </View>
        </View>

        <Text style={styles.footer}>{props.orgName} · Receipt {props.number}</Text>
      </Page>
    </Document>
  )
}
```

`src/server/pdf/StatementDocument.tsx`:
```tsx
import { Document, Page, Text, View } from '@react-pdf/renderer'
import { styles } from '@/server/pdf/styles'
import { formatMinor } from '@/domain/currency'
import type { InstallmentStatus } from '@/domain/status'

export interface StatementProps {
  number: string
  orgName: string
  projectName: string
  projectLocation: string
  unitName: string
  buyerName: string
  buyerPhone: string
  currency: string
  planType: 'FULL' | 'INSTALLMENTS'
  priceMinor: bigint
  depositMinor: bigint
  signedAt: Date
  expectedCompletion: Date
  entries: Array<{
    sequence: number
    dueDate: Date
    amountDueMinor: bigint
    amountPaidMinor: bigint
    status: InstallmentStatus
  }>
  totalMinor: bigint
  paidToDateMinor: bigint
  balanceMinor: bigint
}

const date = (d: Date) => d.toISOString().slice(0, 10)

export function StatementDocument(props: StatementProps) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.orgName}>{props.orgName}</Text>
            <Text style={styles.muted}>{props.projectName}</Text>
            <Text style={styles.muted}>{props.projectLocation}</Text>
          </View>
          <View>
            <Text style={styles.docTitle}>STATEMENT</Text>
            <Text style={styles.muted}>{props.number}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.label}>Buyer</Text>
            <Text>{props.buyerName} · {props.buyerPhone}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Unit</Text>
            <Text>{props.unitName}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Plan</Text>
            <Text>
              {props.planType === 'FULL'
                ? 'Full payment'
                : `${props.entries.length} monthly installments`}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Signed</Text>
            <Text>{date(props.signedAt)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Expected completion</Text>
            <Text>{date(props.expectedCompletion)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Purchase price</Text>
            <Text>{formatMinor(props.priceMinor, props.currency)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Deposit</Text>
            <Text>{formatMinor(props.depositMinor, props.currency)}</Text>
          </View>
        </View>

        <View style={styles.tableHeader}>
          <Text style={styles.colSeq}>#</Text>
          <Text style={styles.colDate}>Due date</Text>
          <Text style={styles.colAmount}>Amount</Text>
          <Text style={styles.colPaid}>Paid</Text>
          <Text style={styles.colStatus}>Status</Text>
        </View>
        {props.entries.map((entry) => (
          <View key={entry.sequence} style={styles.tableRow} wrap={false}>
            <Text style={styles.colSeq}>{entry.sequence}</Text>
            <Text style={styles.colDate}>{date(entry.dueDate)}</Text>
            <Text style={styles.colAmount}>{formatMinor(entry.amountDueMinor, props.currency)}</Text>
            <Text style={styles.colPaid}>{formatMinor(entry.amountPaidMinor, props.currency)}</Text>
            <Text style={styles.colStatus}>{entry.status}</Text>
          </View>
        ))}

        <View style={styles.total}>
          <Text>Total scheduled</Text>
          <Text>{formatMinor(props.totalMinor, props.currency)}</Text>
        </View>
        <View style={styles.total}>
          <Text>Paid to date</Text>
          <Text>{formatMinor(props.paidToDateMinor, props.currency)}</Text>
        </View>
        <View style={styles.total}>
          <Text>Balance</Text>
          <Text>{formatMinor(props.balanceMinor, props.currency)}</Text>
        </View>

        <Text
          style={styles.footer}
          render={({ pageNumber, totalPages }) =>
            `${props.orgName} · Statement ${props.number} · Page ${pageNumber} of ${totalPages}`
          }
          fixed
        />
      </Page>
    </Document>
  )
}
```

- [ ] **Step 6: Implement the renderer**

`src/server/pdf/render.tsx`:
```tsx
import { renderToBuffer } from '@react-pdf/renderer'
import { prisma } from '@/server/db'
import { ServiceError } from '@/server/services/errors'
import { InvoiceDocument } from '@/server/pdf/InvoiceDocument'
import { ReceiptDocument } from '@/server/pdf/ReceiptDocument'
import { StatementDocument } from '@/server/pdf/StatementDocument'
import { deriveStatus } from '@/domain/status'
import { summariseSale } from '@/server/services/sales'

/**
 * Bytes are regenerated on demand rather than stored: payments are immutable
 * and schedules are frozen at signing, so a re-download is byte-identical
 * without any blob storage to configure.
 */
export async function renderDocumentPdf(
  documentId: string,
  orgId: string
): Promise<{ buffer: Buffer; filename: string }> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, orgId },
    include: {
      org: { select: { name: true } },
      sale: {
        include: {
          project: true,
          unit: true,
          buyer: true,
          scheduleEntries: { orderBy: { sequence: 'asc' } }
        }
      },
      scheduleEntry: true,
      payment: { include: { allocations: { include: { scheduleEntry: true } } } }
    }
  })
  if (!doc) throw new ServiceError('Document not found', 'NOT_FOUND')

  const { sale } = doc
  const summary = summariseSale(sale, new Date())
  const filename = `${doc.number}.pdf`

  if (doc.type === 'INVOICE') {
    const entry = doc.scheduleEntry
    if (!entry) throw new ServiceError('Invoice is missing its installment', 'NOT_FOUND')

    return {
      filename,
      buffer: await renderToBuffer(
        <InvoiceDocument
          number={doc.number}
          issuedAt={doc.createdAt}
          orgName={doc.org.name}
          projectName={sale.project.name}
          unitName={sale.unit.name}
          buyerName={sale.buyer.fullName}
          buyerPhone={sale.buyer.phone}
          buyerEmail={sale.buyer.email}
          currency={sale.currency}
          sequence={entry.sequence}
          totalInstallments={sale.scheduleEntries.length}
          dueDate={entry.dueDate}
          amountDueMinor={entry.amountDueMinor}
          amountPaidMinor={entry.amountPaidMinor}
        />
      )
    }
  }

  if (doc.type === 'RECEIPT') {
    const payment = doc.payment
    if (!payment) throw new ServiceError('Receipt is missing its payment', 'NOT_FOUND')

    return {
      filename,
      buffer: await renderToBuffer(
        <ReceiptDocument
          number={doc.number}
          orgName={doc.org.name}
          projectName={sale.project.name}
          unitName={sale.unit.name}
          buyerName={sale.buyer.fullName}
          currency={sale.currency}
          amountMinor={payment.amountMinor}
          receivedAt={payment.receivedAt}
          method={payment.method}
          reference={payment.reference}
          allocations={payment.allocations.map((a) => ({
            sequence: a.scheduleEntry.sequence,
            dueDate: a.scheduleEntry.dueDate,
            amountMinor: a.amountMinor
          }))}
          balanceMinor={summary.balanceMinor}
          voided={payment.voidedAt !== null}
          voidReason={payment.voidReason}
        />
      )
    }
  }

  const asOf = new Date()
  return {
    filename,
    buffer: await renderToBuffer(
      <StatementDocument
        number={doc.number}
        orgName={doc.org.name}
        projectName={sale.project.name}
        projectLocation={sale.project.location}
        unitName={sale.unit.name}
        buyerName={sale.buyer.fullName}
        buyerPhone={sale.buyer.phone}
        currency={sale.currency}
        planType={sale.planType}
        priceMinor={sale.priceMinor}
        depositMinor={sale.depositMinor}
        signedAt={sale.signedAt}
        expectedCompletion={sale.project.expectedCompletion}
        entries={sale.scheduleEntries.map((e) => ({
          sequence: e.sequence,
          dueDate: e.dueDate,
          amountDueMinor: e.amountDueMinor,
          amountPaidMinor: e.amountPaidMinor,
          status: deriveStatus(e, asOf)
        }))}
        totalMinor={sale.scheduleEntries.reduce((s, e) => s + e.amountDueMinor, 0n)}
        paidToDateMinor={summary.paidToDateMinor}
        balanceMinor={summary.balanceMinor}
      />
    )
  }
}
```

- [ ] **Step 7: Add the download route**

`src/app/api/documents/[id]/route.ts`:
```ts
import { NextResponse } from 'next/server'
import { auth } from '@/server/auth'
import { prisma } from '@/server/db'
import { renderDocumentPdf } from '@/server/pdf/render'

export const runtime = 'nodejs'

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user?.id) return new NextResponse('Unauthorized', { status: 401 })

  // Buyers may only fetch documents attached to their own sale. Scoped by the
  // session's buyerId, so a guessed document id returns 404, not a leak.
  const where =
    session.user.role === 'BUYER'
      ? { id: params.id, orgId: session.user.orgId, sale: { buyerId: session.user.buyerId ?? '' } }
      : { id: params.id, orgId: session.user.orgId }

  const allowed = await prisma.document.findFirst({ where, select: { id: true } })
  if (!allowed) return new NextResponse('Not found', { status: 404 })

  const { buffer, filename } = await renderDocumentPdf(params.id, session.user.orgId)

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, max-age=300'
    }
  })
}
```

- [ ] **Step 8: Verify a PDF actually renders**

```bash
npm test -- numbering
npm run typecheck
npm run dev
```
Sign in as `admin@sunrise.test` / `password123`, open a sale, download the statement. Confirm the schedule table paginates across pages and that NGN amounts show `₦` while KES amounts show `KSh` — proof the currency is not hardcoded.

- [ ] **Step 9: Commit**

```bash
git add src/server/documents src/server/pdf src/app/api/documents src/server/__tests__/numbering.test.ts src/server/services/payments.ts
git commit -m "feat(pdf): invoices, receipts and statements with per-org document numbering"
```

---

### Task 16: Channel-agnostic notifications

**Files:**
- Create: `src/server/notifications/sender.ts`, `src/server/notifications/resend.ts`, `src/server/notifications/templates.ts`, `src/server/notifications/dispatch.ts`
- Test: `src/server/__tests__/templates.test.ts`

**Interfaces:**
- Consumes: `formatMinor`, `daysLate`, `prisma`.
- Produces:
  - `type TemplateKey = 'DUE_SOON' | 'OVERDUE'`
  - `renderTemplate(key, data): { subject: string; text: string; html: string }` — pure
  - `interface NotificationSender { channel: ReminderChannel; send(msg): Promise<{ providerMessageId?: string }> }`
  - `getSender(channel): NotificationSender` — throws for SMS until an adapter is registered
  - `dispatchReminder(args): Promise<'SENT' | 'SKIPPED' | 'FAILED'>`

- [ ] **Step 1: Write the failing test**

`src/server/__tests__/templates.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { renderTemplate } from '@/server/notifications/templates'

const base = {
  buyerName: 'Amina Yusuf',
  orgName: 'Sunrise Developments',
  projectName: 'Sunrise Heights',
  unitName: '305',
  currency: 'NGN',
  amountMinor: 166_666_666n,
  dueDate: new Date(Date.UTC(2026, 7, 20)),
  daysUntilDue: 7,
  daysLate: 0,
  documentUrl: 'https://example.com/api/documents/doc_1'
}

describe('renderTemplate', () => {
  it('renders a due-soon notice naming the amount and date', () => {
    const out = renderTemplate('DUE_SOON', base)
    expect(out.subject).toContain('Sunrise Heights')
    expect(out.text).toContain('Amina Yusuf')
    expect(out.text).toContain('2026-08-20')
    expect(out.text).toContain('1,666,666.66')
    expect(out.text).toContain('7 days')
  })

  it('renders an overdue notice naming the lateness', () => {
    const out = renderTemplate('OVERDUE', { ...base, daysLate: 12, daysUntilDue: 0 })
    expect(out.subject.toLowerCase()).toContain('overdue')
    expect(out.text).toContain('12 days')
  })

  it('uses the singular for a single day', () => {
    expect(renderTemplate('DUE_SOON', { ...base, daysUntilDue: 1 }).text).toContain('1 day')
    expect(renderTemplate('DUE_SOON', { ...base, daysUntilDue: 1 }).text).not.toContain('1 days')
  })

  it('formats amounts in the project currency, not USD', () => {
    const kes = renderTemplate('DUE_SOON', { ...base, currency: 'KES', amountMinor: 25_555_600n })
    expect(kes.text).toContain('255,556')
    expect(kes.text).not.toContain('$')
  })

  it('includes the document link in the html body', () => {
    expect(renderTemplate('DUE_SOON', base).html).toContain(base.documentUrl)
  })

  it('produces a plain-text body for low-bandwidth clients', () => {
    expect(renderTemplate('DUE_SOON', base).text).not.toContain('<')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- templates
```
Expected: FAIL.

- [ ] **Step 3: Implement the templates**

`src/server/notifications/templates.ts`:
```ts
import { formatMinor } from '@/domain/currency'

export type TemplateKey = 'DUE_SOON' | 'OVERDUE'

export interface TemplateData {
  buyerName: string
  orgName: string
  projectName: string
  unitName: string
  currency: string
  amountMinor: bigint
  dueDate: Date
  daysUntilDue: number
  daysLate: number
  documentUrl: string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const isoDate = (d: Date) => d.toISOString().slice(0, 10)

export function renderTemplate(key: TemplateKey, data: TemplateData) {
  const amount = formatMinor(data.amountMinor, data.currency)
  const due = isoDate(data.dueDate)

  const subject =
    key === 'DUE_SOON'
      ? `Payment due in ${plural(data.daysUntilDue, 'day')} — ${data.projectName} unit ${data.unitName}`
      : `Overdue payment — ${data.projectName} unit ${data.unitName}`

  const lead =
    key === 'DUE_SOON'
      ? `Your next installment of ${amount} for unit ${data.unitName} is due on ${due}, in ${plural(data.daysUntilDue, 'day')}.`
      : `Your installment of ${amount} for unit ${data.unitName} was due on ${due} and is now ${plural(data.daysLate, 'day')} late.`

  const text = [
    `Hello ${data.buyerName},`,
    '',
    lead,
    '',
    `Project: ${data.projectName}`,
    `Unit: ${data.unitName}`,
    `Amount: ${amount}`,
    `Due date: ${due}`,
    '',
    `View or download the invoice: ${data.documentUrl}`,
    '',
    data.orgName
  ].join('\n')

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a;line-height:1.5">
<p>Hello ${data.buyerName},</p>
<p>${lead}</p>
<table cellpadding="6" style="border-collapse:collapse;font-size:14px">
<tr><td style="color:#64748b">Project</td><td>${data.projectName}</td></tr>
<tr><td style="color:#64748b">Unit</td><td>${data.unitName}</td></tr>
<tr><td style="color:#64748b">Amount</td><td><strong>${amount}</strong></td></tr>
<tr><td style="color:#64748b">Due date</td><td>${due}</td></tr>
</table>
<p><a href="${data.documentUrl}">View or download the invoice</a></p>
<p style="color:#64748b">${data.orgName}</p>
</body></html>`

  return { subject, text, html }
}
```

- [ ] **Step 4: Implement the channel abstraction**

`src/server/notifications/sender.ts`:
```ts
import type { ReminderChannel } from '@prisma/client'

export interface OutboundMessage {
  destination: string
  subject: string
  text: string
  html: string
}

export interface NotificationSender {
  channel: ReminderChannel
  send(message: OutboundMessage): Promise<{ providerMessageId?: string }>
}

const registry = new Map<ReminderChannel, NotificationSender>()

export function registerSender(sender: NotificationSender): void {
  registry.set(sender.channel, sender)
}

export class ChannelUnavailableError extends Error {
  constructor(channel: ReminderChannel) {
    super(`No sender is registered for the ${channel} channel`)
    this.name = 'ChannelUnavailableError'
  }
}

export function getSender(channel: ReminderChannel): NotificationSender {
  const sender = registry.get(channel)
  if (!sender) throw new ChannelUnavailableError(channel)
  return sender
}

/**
 * Adding SMS later is exactly this and nothing more:
 *
 *   registerSender({
 *     channel: 'SMS',
 *     async send({ destination, text }) {
 *       const res = await africasTalking.send({ to: destination, message: text })
 *       return { providerMessageId: res.id }
 *     }
 *   })
 *
 * The enum value, the Project.reminderChannels array, Buyer.phone in E.164,
 * Buyer.smsOptIn and NotificationLog.destination all already exist, so no
 * migration is involved.
 */
```

`src/server/notifications/resend.ts`:
```ts
import { Resend } from 'resend'
import { registerSender } from '@/server/notifications/sender'

let registered = false

export function ensureEmailSender(): void {
  if (registered) return

  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.EMAIL_FROM
  if (!apiKey || !from) {
    throw new Error('RESEND_API_KEY and EMAIL_FROM must be set to send email')
  }

  const resend = new Resend(apiKey)

  registerSender({
    channel: 'EMAIL',
    async send({ destination, subject, text, html }) {
      const result = await resend.emails.send({ from, to: destination, subject, text, html })
      if (result.error) throw new Error(result.error.message)
      return { providerMessageId: result.data?.id }
    }
  })

  registered = true
}
```

- [ ] **Step 5: Implement dispatch with idempotency**

`src/server/notifications/dispatch.ts`:
```ts
import type { ReminderChannel } from '@prisma/client'
import { prisma } from '@/server/db'
import { getSender } from '@/server/notifications/sender'
import { renderTemplate, type TemplateData, type TemplateKey } from '@/server/notifications/templates'

export type DispatchOutcome = 'SENT' | 'SKIPPED' | 'FAILED'

export async function dispatchReminder(args: {
  orgId: string
  scheduleEntryId: string
  channel: ReminderChannel
  templateKey: TemplateKey
  destination: string
  data: TemplateData
}): Promise<DispatchOutcome> {
  // The unique index does the work: if this reminder was already logged, the
  // create throws P2002 and we skip. A retried cron run cannot double-send.
  try {
    await prisma.notificationLog.create({
      data: {
        orgId: args.orgId,
        scheduleEntryId: args.scheduleEntryId,
        channel: args.channel,
        templateKey: args.templateKey,
        destination: args.destination,
        status: 'PENDING'
      }
    })
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      return 'SKIPPED'
    }
    throw error
  }

  const message = renderTemplate(args.templateKey, args.data)

  try {
    const { providerMessageId } = await getSender(args.channel).send({
      destination: args.destination,
      ...message
    })

    await prisma.notificationLog.update({
      where: {
        scheduleEntryId_templateKey_channel: {
          scheduleEntryId: args.scheduleEntryId,
          templateKey: args.templateKey,
          channel: args.channel
        }
      },
      data: { status: 'SENT', sentAt: new Date(), providerMessageId: providerMessageId ?? null }
    })

    return 'SENT'
  } catch (error) {
    await prisma.notificationLog.update({
      where: {
        scheduleEntryId_templateKey_channel: {
          scheduleEntryId: args.scheduleEntryId,
          templateKey: args.templateKey,
          channel: args.channel
        }
      },
      data: { status: 'FAILED', error: error instanceof Error ? error.message : String(error) }
    })

    return 'FAILED'
  }
}
```

Note the FAILED row is left in place deliberately: a permanently broken address should not be retried every single day. Re-sending is a manual action that deletes the log row.

- [ ] **Step 6: Run tests**

```bash
npm test -- templates
npm run typecheck
```
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add src/server/notifications src/server/__tests__/templates.test.ts
git commit -m "feat(notifications): channel-agnostic sender with Resend adapter and idempotent dispatch"
```

---

### Task 17: Vercel cron reminder job

**Files:**
- Create: `src/app/api/cron/reminders/route.ts`, `src/server/notifications/reminders.ts`, `vercel.json`
- Test: `src/server/__tests__/reminders.test.ts`

**Interfaces:**
- Consumes: `dispatchReminder`, `issueInvoice`, `prisma`, `differenceInDaysUtc`.
- Produces:
  - `planReminders(sales, asOf): ReminderJob[]` — pure
  - `runReminderSweep(asOf): Promise<{ sent: number; skipped: number; failed: number }>`

- [ ] **Step 1: Write the failing test for the pure planner**

`src/server/__tests__/reminders.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { planReminders } from '@/server/notifications/reminders'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

const sale = (entries: Array<[string, Date, bigint, bigint]>, overrides = {}) => ({
  id: 'sale_1',
  orgId: 'org_1',
  currency: 'NGN',
  project: {
    name: 'Sunrise Heights',
    reminderDaysBefore: 7,
    overdueNoticeDaysAfter: 3,
    reminderChannels: ['EMAIL' as const],
    ...overrides
  },
  unit: { name: '305' },
  buyer: { fullName: 'Amina Yusuf', email: 'amina@buyer.test', phone: '+2348031234567', smsOptIn: true },
  scheduleEntries: entries.map(([id, dueDate, amountDueMinor, amountPaidMinor]) => ({
    id,
    dueDate,
    amountDueMinor,
    amountPaidMinor
  }))
})

describe('planReminders', () => {
  const asOf = utc(2026, 8, 9)

  it('schedules a due-soon notice exactly N days before the due date', () => {
    const jobs = planReminders([sale([['e1', utc(2026, 8, 16), 300n, 0n]])], asOf)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].templateKey).toBe('DUE_SOON')
    expect(jobs[0].daysUntilDue).toBe(7)
    expect(jobs[0].destination).toBe('amina@buyer.test')
  })

  it('schedules nothing on other days before the due date', () => {
    expect(planReminders([sale([['e1', utc(2026, 8, 15), 300n, 0n]])], asOf)).toEqual([])
    expect(planReminders([sale([['e1', utc(2026, 8, 17), 300n, 0n]])], asOf)).toEqual([])
  })

  it('schedules an overdue notice exactly N days after the due date', () => {
    const jobs = planReminders([sale([['e1', utc(2026, 8, 6), 300n, 0n]])], asOf)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].templateKey).toBe('OVERDUE')
    expect(jobs[0].daysLate).toBe(3)
  })

  it('respects a per-project reminder window', () => {
    const jobs = planReminders(
      [sale([['e1', utc(2026, 8, 19), 300n, 0n]], { reminderDaysBefore: 10 })],
      asOf
    )
    expect(jobs).toHaveLength(1)
    expect(jobs[0].daysUntilDue).toBe(10)
  })

  it('never reminds about a fully paid installment', () => {
    expect(planReminders([sale([['e1', utc(2026, 8, 16), 300n, 300n]])], asOf)).toEqual([])
    expect(planReminders([sale([['e1', utc(2026, 8, 6), 300n, 300n]])], asOf)).toEqual([])
  })

  it('still reminds about a partially paid installment, for the balance', () => {
    const jobs = planReminders([sale([['e1', utc(2026, 8, 16), 300n, 100n]])], asOf)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].amountMinor).toBe(200n)
  })

  it('emits one job per configured channel', () => {
    const jobs = planReminders(
      [sale([['e1', utc(2026, 8, 16), 300n, 0n]], { reminderChannels: ['EMAIL', 'SMS'] })],
      asOf
    )
    expect(jobs.map((j) => j.channel).sort()).toEqual(['EMAIL', 'SMS'])
    expect(jobs.find((j) => j.channel === 'SMS')?.destination).toBe('+2348031234567')
  })

  it('skips the SMS channel when the buyer has opted out', () => {
    const base = sale([['e1', utc(2026, 8, 16), 300n, 0n]], { reminderChannels: ['EMAIL', 'SMS'] })
    const jobs = planReminders([{ ...base, buyer: { ...base.buyer, smsOptIn: false } }], asOf)
    expect(jobs.map((j) => j.channel)).toEqual(['EMAIL'])
  })

  it('handles several entries across several sales', () => {
    const jobs = planReminders(
      [
        sale([['e1', utc(2026, 8, 16), 300n, 0n], ['e2', utc(2026, 9, 16), 300n, 0n]]),
        { ...sale([['e3', utc(2026, 8, 6), 300n, 0n]]), id: 'sale_2' }
      ],
      asOf
    )
    expect(jobs.map((j) => j.scheduleEntryId).sort()).toEqual(['e1', 'e3'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- reminders
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/server/notifications/reminders.ts`**

```ts
import type { ReminderChannel } from '@prisma/client'
import { prisma } from '@/server/db'
import { differenceInDaysUtc } from '@/domain/dates'
import { outstandingMinor } from '@/domain/status'
import { dispatchReminder } from '@/server/notifications/dispatch'
import { ensureEmailSender } from '@/server/notifications/resend'
import type { TemplateKey } from '@/server/notifications/templates'

export interface ReminderJob {
  orgId: string
  saleId: string
  scheduleEntryId: string
  channel: ReminderChannel
  templateKey: TemplateKey
  destination: string
  buyerName: string
  projectName: string
  unitName: string
  currency: string
  amountMinor: bigint
  dueDate: Date
  daysUntilDue: number
  daysLate: number
}

interface ReminderSale {
  id: string
  orgId: string
  currency: string
  project: {
    name: string
    reminderDaysBefore: number
    overdueNoticeDaysAfter: number
    reminderChannels: ReminderChannel[]
  }
  unit: { name: string }
  buyer: { fullName: string; email: string; phone: string; smsOptIn: boolean }
  scheduleEntries: Array<{
    id: string
    dueDate: Date
    amountDueMinor: bigint
    amountPaidMinor: bigint
  }>
}

/** Pure: decides what should be sent today. No I/O, no clock. */
export function planReminders(sales: ReminderSale[], asOf: Date): ReminderJob[] {
  const jobs: ReminderJob[] = []

  for (const sale of sales) {
    for (const entry of sale.scheduleEntries) {
      const outstanding = outstandingMinor(entry)
      if (outstanding === 0n) continue

      const offset = differenceInDaysUtc(entry.dueDate, asOf)

      let templateKey: TemplateKey | null = null
      if (offset === sale.project.reminderDaysBefore) templateKey = 'DUE_SOON'
      else if (-offset === sale.project.overdueNoticeDaysAfter) templateKey = 'OVERDUE'
      if (!templateKey) continue

      for (const channel of sale.project.reminderChannels) {
        if (channel === 'SMS' && !sale.buyer.smsOptIn) continue

        jobs.push({
          orgId: sale.orgId,
          saleId: sale.id,
          scheduleEntryId: entry.id,
          channel,
          templateKey,
          destination: channel === 'EMAIL' ? sale.buyer.email : sale.buyer.phone,
          buyerName: sale.buyer.fullName,
          projectName: sale.project.name,
          unitName: sale.unit.name,
          currency: sale.currency,
          amountMinor: outstanding,
          dueDate: entry.dueDate,
          daysUntilDue: offset > 0 ? offset : 0,
          daysLate: offset < 0 ? -offset : 0
        })
      }
    }
  }

  return jobs
}

export async function runReminderSweep(asOf: Date) {
  ensureEmailSender()

  const sales = await prisma.sale.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      orgId: true,
      currency: true,
      project: {
        select: {
          name: true,
          reminderDaysBefore: true,
          overdueNoticeDaysAfter: true,
          reminderChannels: true
        }
      },
      unit: { select: { name: true } },
      buyer: { select: { fullName: true, email: true, phone: true, smsOptIn: true } },
      scheduleEntries: {
        select: { id: true, dueDate: true, amountDueMinor: true, amountPaidMinor: true }
      }
    }
  })

  const jobs = planReminders(sales, asOf)
  const baseUrl = process.env.NEXTAUTH_URL ?? ''
  const tally = { sent: 0, skipped: 0, failed: 0 }

  for (const job of jobs) {
    // SMS has no registered sender yet; skip rather than fail the sweep.
    if (job.channel === 'SMS') {
      tally.skipped += 1
      continue
    }

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: job.orgId },
      select: { name: true }
    })

    const outcome = await dispatchReminder({
      orgId: job.orgId,
      scheduleEntryId: job.scheduleEntryId,
      channel: job.channel,
      templateKey: job.templateKey,
      destination: job.destination,
      data: {
        buyerName: job.buyerName,
        orgName: org.name,
        projectName: job.projectName,
        unitName: job.unitName,
        currency: job.currency,
        amountMinor: job.amountMinor,
        dueDate: job.dueDate,
        daysUntilDue: job.daysUntilDue,
        daysLate: job.daysLate,
        documentUrl: `${baseUrl}/dashboard`
      }
    })

    if (outcome === 'SENT') tally.sent += 1
    else if (outcome === 'SKIPPED') tally.skipped += 1
    else tally.failed += 1
  }

  return tally
}
```

- [ ] **Step 4: Implement the cron route**

`src/app/api/cron/reminders/route.ts`:
```ts
import { NextResponse } from 'next/server'
import { runReminderSweep } from '@/server/notifications/reminders'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET

  // Fail closed. An unset secret is a misconfiguration, never an open door.
  if (!secret) {
    return new NextResponse('CRON_SECRET is not configured', { status: 401 })
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const tally = await runReminderSweep(new Date())
  return NextResponse.json({ ok: true, ...tally })
}
```

`vercel.json`:
```json
{
  "crons": [{ "path": "/api/cron/reminders", "schedule": "0 7 * * *" }]
}
```

- [ ] **Step 5: Verify the fail-closed guard locally**

```bash
curl -i http://localhost:3000/api/cron/reminders
```
Expected: `HTTP/1.1 401`.

```bash
curl -i -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reminders
```
Expected: `200` with a JSON tally.

Run the authorised request twice. The second run must report the same jobs as `skipped`, not `sent` — that is the idempotency guard doing its job.

- [ ] **Step 6: Run tests**

```bash
npm test -- reminders
```
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/cron src/server/notifications/reminders.ts vercel.json src/server/__tests__/reminders.test.ts
git commit -m "feat(cron): daily reminder sweep with fail-closed auth and pure job planning"
```

---

### Task 18: Auth pages and the app shell

**Files:**
- Create: `src/components/ui.tsx`, `src/components/StatusBadge.tsx`, `src/app/(auth)/login/page.tsx`, `src/app/(auth)/login/actions.ts`, `src/app/(staff)/layout.tsx`, `src/app/(buyer)/layout.tsx`
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `signIn`, `signOut` from `@/server/auth`, `requireUser`.
- Produces: `Field`, `Button`, `Card`, `PageHeader`, `Money`, `StatusBadge` components used by every later UI task.

Mobile-first throughout: single-column below `sm:`, tap targets at least 44px tall, no client-side data fetching.

- [ ] **Step 1: Create shared UI primitives**

`src/components/ui.tsx`:
```tsx
import type { ReactNode } from 'react'

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      {children}
    </div>
  )
}

export function Field({
  label,
  name,
  type = 'text',
  required,
  defaultValue,
  placeholder,
  hint,
  children
}: {
  label: string
  name: string
  type?: string
  required?: boolean
  defaultValue?: string | number
  placeholder?: string
  hint?: string
  children?: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required ? <span className="text-rose-600"> *</span> : null}
      </span>
      {children ?? (
        <input
          name={name}
          type={type}
          required={required}
          defaultValue={defaultValue}
          placeholder={placeholder}
          className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base outline-none focus:border-slate-900"
        />
      )}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  )
}

export function Button({
  children,
  variant = 'primary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const styles = {
    primary: 'bg-slate-900 text-white hover:bg-slate-800',
    secondary: 'border border-slate-300 bg-white text-slate-900 hover:bg-slate-50',
    danger: 'bg-rose-600 text-white hover:bg-rose-500'
  }[variant]

  return (
    <button
      {...props}
      className={`min-h-11 rounded-lg px-4 text-sm font-medium disabled:opacity-50 ${styles}`}
    >
      {children}
    </button>
  )
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null
  return <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{children}</p>
}
```

`src/components/StatusBadge.tsx`:
```tsx
import type { InstallmentStatus } from '@/domain/status'

const TONE: Record<InstallmentStatus, string> = {
  PAID: 'bg-emerald-100 text-emerald-800',
  PARTIAL: 'bg-amber-100 text-amber-800',
  OVERDUE: 'bg-rose-100 text-rose-800',
  PENDING: 'bg-slate-100 text-slate-700'
}

export function StatusBadge({ status }: { status: InstallmentStatus }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${TONE[status]}`}>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  )
}
```

- [ ] **Step 2: Create the login page**

`src/app/(auth)/login/actions.ts`:
```ts
'use server'

import { AuthError } from 'next-auth'
import { signIn } from '@/server/auth'

export async function loginAction(_prev: string | undefined, formData: FormData) {
  try {
    await signIn('credentials', {
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
      redirectTo: '/'
    })
  } catch (error) {
    if (error instanceof AuthError) {
      // One message for both wrong-email and wrong-password, so the form
      // cannot be used to discover which addresses are registered.
      return 'Email or password is incorrect.'
    }
    throw error
  }
}
```

`src/app/(auth)/login/page.tsx`:
```tsx
'use client'

import { useFormState, useFormStatus } from 'react-dom'
import { Button, Card, ErrorText, Field } from '@/components/ui'
import { loginAction } from './actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  )
}

export default function LoginPage() {
  const [error, formAction] = useFormState(loginAction, undefined)

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-5">
      <h1 className="mb-1 text-2xl font-semibold">Sign in</h1>
      <p className="mb-5 text-sm text-slate-500">Developers, agents and buyers.</p>

      <Card>
        <form action={formAction} className="space-y-4">
          <ErrorText>{error}</ErrorText>
          <Field label="Email" name="email" type="email" required />
          <Field label="Password" name="password" type="password" required />
          <Submit />
        </form>
      </Card>
    </main>
  )
}
```

- [ ] **Step 3: Create the role-aware landing redirect**

Replace `src/app/page.tsx`:
```tsx
import { redirect } from 'next/navigation'
import { requireUser } from '@/server/session'

export default async function Home() {
  const actor = await requireUser()
  redirect(actor.role === 'BUYER' ? '/dashboard' : '/projects')
}
```

- [ ] **Step 4: Create the shell layouts**

`src/app/(staff)/layout.tsx`:
```tsx
import Link from 'next/link'
import { requireStaff } from '@/server/session'
import { signOut } from '@/server/auth'

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireStaff()

  return (
    <div className="min-h-dvh">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 p-3">
          <nav className="flex gap-3 text-sm font-medium">
            <Link href="/projects">Projects</Link>
            <Link href="/arrears">Arrears</Link>
          </nav>
          <form
            action={async () => {
              'use server'
              await signOut({ redirectTo: '/login' })
            }}
          >
            <button className="text-sm text-slate-500">
              {actor.fullName.split(' ')[0]} · Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 sm:p-6">{children}</main>
    </div>
  )
}
```

`src/app/(buyer)/layout.tsx`: identical structure, but calls `requireBuyer()` and its nav is a single `Dashboard` link to `/dashboard`.

- [ ] **Step 5: Verify sign-in works for all three roles**

```bash
npm run dev
```
Sign in as `admin@sunrise.test`, `agent@sunrise.test` and `amina@buyer.test` (all `password123`). Confirm admin/agent land on `/projects`, the buyer lands on `/dashboard`, and a buyer navigating directly to `/arrears` is refused.

- [ ] **Step 6: Commit**

```bash
git add src/components src/app
git commit -m "feat(ui): login, role-aware landing, and mobile-first app shell"
```

---

### Task 19: Developer project setup and floor inventory

**Files:**
- Create: `src/app/(staff)/projects/page.tsx`, `src/app/(staff)/projects/new/page.tsx`, `src/app/(staff)/projects/actions.ts`, `src/app/(staff)/projects/[id]/page.tsx`, `src/app/(staff)/projects/[id]/UnitRow.tsx`
- Consumes: `createProject`, `listProjects`, `getProjectInventory`, `updateUnit`, `UNIT_PATTERN_PRESETS`, `SUPPORTED_CURRENCIES`, `formatMinor`.

- [ ] **Step 1: Create the project list**

`src/app/(staff)/projects/page.tsx`:
```tsx
import Link from 'next/link'
import { requireStaff } from '@/server/session'
import { listProjects } from '@/server/services/projects'
import { Card, PageHeader } from '@/components/ui'

export default async function ProjectsPage() {
  const actor = await requireStaff()
  const projects = await listProjects(actor)

  return (
    <>
      <PageHeader
        title="Projects"
        action={
          actor.role === 'ADMIN' ? (
            <Link href="/projects/new" className="min-h-11 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white">
              New project
            </Link>
          ) : null
        }
      />

      {projects.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">No projects yet.</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {projects.map((project) => (
            <li key={project.id}>
              <Link href={`/projects/${project.id}`}>
                <Card className="active:bg-slate-50">
                  <p className="font-medium">{project.name}</p>
                  <p className="text-sm text-slate-500">{project.location}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    {project._count.units} units · {project.currency} · completing{' '}
                    {project.expectedCompletion.toISOString().slice(0, 10)}
                  </p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
```

- [ ] **Step 2: Create the server actions**

`src/app/(staff)/projects/actions.ts`:
```ts
'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireStaff } from '@/server/session'
import { CreateProjectSchema, createProject } from '@/server/services/projects'
import { UpdateUnitSchema, updateUnit } from '@/server/services/units'
import { ServiceError } from '@/server/services/errors'

export async function createProjectAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireStaff()
  const parsed = CreateProjectSchema.safeParse(Object.fromEntries(formData))

  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? 'Please check the form and try again.'
  }

  let projectId: string
  try {
    const result = await createProject(actor, parsed.data)
    projectId = result.id
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not create the project.'
  }

  redirect(`/projects/${projectId}`)
}

export async function updateUnitAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireStaff()
  const unitId = String(formData.get('unitId') ?? '')
  const projectId = String(formData.get('projectId') ?? '')

  const parsed = UpdateUnitSchema.safeParse({
    name: formData.get('name') || undefined,
    bedrooms: formData.get('bedrooms') || undefined,
    sizeSqm: formData.get('sizeSqm') || undefined,
    price: formData.get('price') || undefined
  })
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Invalid values.'

  try {
    await updateUnit(actor, unitId, parsed.data)
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not update the unit.'
  }

  revalidatePath(`/projects/${projectId}`)
}
```

- [ ] **Step 3: Create the project form**

`src/app/(staff)/projects/new/page.tsx` — a client component using `useFormState(createProjectAction, undefined)`, wrapped in `<form action={formAction} className="space-y-4">`, with these fields in order:

```tsx
<Field label="Building name" name="name" required placeholder="Sunrise Heights" />
<Field label="Location" name="location" required placeholder="Lekki Phase 1, Lagos" />

<Field label="Currency" name="currency" required hint="Prices for this project are set and displayed in this currency.">
  <select name="currency" required className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base">
    {Object.keys(SUPPORTED_CURRENCIES).map((code) => (
      <option key={code} value={code}>{code}</option>
    ))}
  </select>
</Field>

<Field label="Expected completion" name="expectedCompletion" type="date" required />

<div className="grid grid-cols-3 gap-3">
  <Field label="Floors" name="floors" type="number" required defaultValue={4} />
  <Field label="Units / floor" name="unitsPerFloor" type="number" required defaultValue={6} />
  <Field label="First floor no." name="startFloor" type="number" required defaultValue={1} />
</div>

<Field label="Unit naming pattern" name="namingPattern" required
  hint="{floor} is the floor number, {index:02} a zero-padded count, {letter} a letter.">
  <select name="namingPattern" className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base">
    {UNIT_PATTERN_PRESETS.map((preset) => (
      <option key={preset.pattern} value={preset.pattern}>{preset.label}</option>
    ))}
  </select>
</Field>

<div className="grid grid-cols-3 gap-3">
  <Field label="Bedrooms" name="defaultBedrooms" type="number" required defaultValue={2} />
  <Field label="Size (m²)" name="defaultSizeSqm" required defaultValue="90.00" />
  <Field label="Price" name="defaultPrice" required placeholder="145000000" />
</div>

<div className="grid grid-cols-2 gap-3">
  <Field label="Remind days before" name="reminderDaysBefore" type="number" required defaultValue={7} />
  <Field label="Overdue notice after" name="overdueNoticeDaysAfter" type="number" required defaultValue={3} />
</div>
```

Add a note above the price fields: *"These apply to every generated unit. Edit individual units afterwards."*

- [ ] **Step 4: Create the floor inventory view**

`src/app/(staff)/projects/[id]/page.tsx`:
```tsx
import { requireStaff } from '@/server/session'
import { getProjectInventory } from '@/server/services/units'
import { exponentFor, formatMinor } from '@/domain/currency'
import { Card, PageHeader } from '@/components/ui'
import { UnitRow } from './UnitRow'

const TONE = {
  AVAILABLE: 'bg-emerald-100 text-emerald-800',
  RESERVED: 'bg-amber-100 text-amber-800',
  SOLD: 'bg-slate-200 text-slate-600'
} as const

export default async function ProjectPage({ params }: { params: { id: string } }) {
  const actor = await requireStaff()
  const { project, floors, totals } = await getProjectInventory(actor, params.id)

  return (
    <>
      <PageHeader title={project.name} subtitle={project.location} />

      <div className="mb-5 grid grid-cols-3 gap-3">
        {[
          ['Available', totals.available, 'text-emerald-700'],
          ['Reserved', totals.reserved, 'text-amber-700'],
          ['Sold', totals.sold, 'text-slate-700']
        ].map(([label, value, tone]) => (
          <Card key={label as string}>
            <p className="text-xs text-slate-500">{label as string}</p>
            <p className={`text-2xl font-semibold ${tone as string}`}>{value as number}</p>
          </Card>
        ))}
      </div>

      <div className="space-y-4">
        {floors.map((floor) => (
          <Card key={floor.floor}>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="font-semibold">Floor {floor.floor}</h2>
              <span className="text-xs text-slate-500">
                {floor.available} of {floor.total} available
              </span>
            </div>

            <ul className="divide-y divide-slate-100">
              {floor.units.map((unit) => (
                <UnitRow
                  key={unit.id}
                  projectId={project.id}
                  unit={{
                    id: unit.id,
                    name: unit.name,
                    bedrooms: unit.bedrooms,
                    sizeSqm: unit.sizeSqm,
                    status: unit.status,
                    // BigInt is not serializable across the RSC boundary, so
                    // formatting happens here on the server.
                    priceLabel: formatMinor(unit.priceMinor, project.currency),
                    // Exponent-aware: dividing by 100n would be wrong for RWF.
                    priceInput: (
                      unit.priceMinor / 10n ** BigInt(exponentFor(project.currency))
                    ).toString()
                  }}
                  tone={TONE[unit.status]}
                  editable={actor.role === 'ADMIN'}
                />
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  )
}
```

- [ ] **Step 5: Create the editable unit row**

`src/app/(staff)/projects/[id]/UnitRow.tsx` — a client component that renders the unit name, bedroom/size summary, formatted price and a status pill. When `editable`, tapping the row reveals an inline `<form action={updateUnitAction}>` with `name`, `bedrooms`, `sizeSqm` and `price` fields plus hidden `unitId` and `projectId`, and a Save button. Collapsed by default so the floor list stays scannable on a phone.

- [ ] **Step 6: Verify end to end**

```bash
npm run dev
```
As admin, create a project with 3 floors × 4 units and the `{floor}{letter}` pattern; confirm 12 units named 1A–3D appear grouped by floor, top floor first. Rename `1A` to `PH1` and confirm it persists. Attempt to rename `1B` to `PH1` and confirm the conflict message appears rather than a crash.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(staff)/projects"
git commit -m "feat(ui): project setup with auto-generated units and floor inventory"
```

---

### Task 20: Buyer purchase flow

**Files:**
- Create: `src/app/buy/[projectId]/page.tsx`, `src/app/buy/[projectId]/actions.ts`, `src/app/buy/[projectId]/PlanPicker.tsx`, `src/app/buy/[projectId]/confirm/page.tsx`

**Interfaces:**
- Consumes: `registerBuyer`, `previewSchedule`, `createSale`, `getProjectInventory`, `issueStatement`, `formatMinor`, `DEFAULT_TERM_MONTHS`.

The buyer must see the entire schedule before committing. That is the point of this screen.

- [ ] **Step 1: Registration and unit selection**

`src/app/buy/[projectId]/page.tsx` is a Server Component rendering, in one scrollable page:

1. The project name, location and expected completion.
2. A registration form (`fullName` required, `phone` required with the hint *"Include your country code, e.g. +2348031234567"*, `email` required, `address` optional, `password` required) — skipped and replaced by a summary line if the visitor is already signed in as a buyer.
3. A radio list of available units only, each showing name, bedrooms, size and formatted price.
4. A plan picker (`PlanPicker`, client component): Full payment or Installments; when Installments is chosen it reveals a deposit input and a term input defaulting to `DEFAULT_TERM_MONTHS`.
5. A "See my payment schedule" submit button.

- [ ] **Step 2: Schedule preview before commitment**

`src/app/buy/[projectId]/confirm/page.tsx` receives the choice as search params, calls `previewSchedule` — which touches no database — and renders:

- A summary block: unit, price, deposit, monthly amount, final amount (shown separately when it differs), term, first and last due dates.
- The **complete** table of every installment: number, due date, amount. Not a truncated preview — the spec requires the buyer sees the whole schedule.
- An explanatory line where the final installment differs: *"Your last payment is {amount} because the monthly figure is rounded down to the nearest {minor unit}."*
- A Confirm button posting to `createSaleAction`, and a Back link.

```tsx
const preview = previewSchedule({
  planType,
  priceMinor: unit.priceMinor,
  depositMinor: toMinor(deposit, project.currency),
  months: termMonths,
  signedAt: new Date()
})

const rows = preview.entries.map((entry) => ({
  sequence: entry.sequence,
  dueDate: entry.dueDate.toISOString().slice(0, 10),
  amount: formatMinor(entry.amountDueMinor, project.currency)
}))
```

- [ ] **Step 3: The commit action**

`src/app/buy/[projectId]/actions.ts`:
```ts
'use server'

import { redirect } from 'next/navigation'
import { signIn } from '@/server/auth'
import { requireUser } from '@/server/session'
import { prisma } from '@/server/db'
import { ServiceError } from '@/server/services/errors'
import {
  BuyerRegistrationSchema,
  PlanSelectionSchema,
  createSale,
  registerBuyer
} from '@/server/services/sales'
import { issueStatement } from '@/server/documents/issue'

export async function registerAndSelectAction(
  projectId: string,
  _prev: string | undefined,
  formData: FormData
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { orgId: true }
  })
  if (!project) return 'That project could not be found.'

  const parsed = BuyerRegistrationSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Please check your details.'

  const plan = PlanSelectionSchema.safeParse(Object.fromEntries(formData))
  if (!plan.success) return plan.error.issues[0]?.message ?? 'Please choose a unit and a plan.'

  try {
    await registerBuyer(project.orgId, parsed.data)
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not create your account.'
  }

  await signIn('credentials', {
    email: parsed.data.email,
    password: parsed.data.password,
    redirect: false
  })

  const query = new URLSearchParams({
    unitId: plan.data.unitId,
    planType: plan.data.planType,
    deposit: plan.data.deposit,
    termMonths: String(plan.data.termMonths)
  })
  redirect(`/buy/${projectId}/confirm?${query.toString()}`)
}

export async function createSaleAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireUser()
  const plan = PlanSelectionSchema.safeParse(Object.fromEntries(formData))
  if (!plan.success) return 'Please choose a unit and a plan.'

  const buyerId =
    actor.role === 'BUYER'
      ? actor.buyerId
      : String(formData.get('buyerId') ?? '')
  if (!buyerId) return 'No buyer is associated with this purchase.'

  let saleId: string
  try {
    const result = await createSale(actor, {
      buyerId,
      unitId: plan.data.unitId,
      planType: plan.data.planType,
      deposit: plan.data.deposit,
      termMonths: plan.data.termMonths,
      signedAt: new Date()
    })
    saleId = result.saleId
  } catch (error) {
    // The likely failure here is losing the race for the unit — say so plainly.
    return error instanceof ServiceError ? error.message : 'Could not complete the purchase.'
  }

  // A statement of the full schedule at signing, per the spec.
  await issueStatement(actor, saleId)

  redirect(actor.role === 'BUYER' ? '/dashboard' : `/sales/${saleId}`)
}
```

- [ ] **Step 4: Verify, including the race**

Open `/buy/<lagos project id>` in two browser windows, select the **same** unit in both, and confirm in both. Expected: the first succeeds; the second shows *"That unit was just taken by someone else"* and no second sale row exists.

```bash
npx tsx -e "import{prisma}from'./src/server/db';prisma.sale.groupBy({by:['unitId'],_count:true,having:{unitId:{_count:{gt:1}}}}).then(r=>console.log('duplicate unit sales:',r.length))"
```
Expected: `duplicate unit sales: 0`.

- [ ] **Step 5: Commit**

```bash
git add src/app/buy
git commit -m "feat(ui): buyer registration, unit selection, and full schedule preview before commitment"
```

---

### Task 21: Buyer dashboard

**Files:**
- Create: `src/app/(buyer)/dashboard/page.tsx`

**Interfaces:**
- Consumes: `requireBuyer`, `getSaleForBuyer`, `summariseSale`, `deriveStatus`, `formatMinor`, `StatusBadge`.

- [ ] **Step 1: Implement the dashboard**

`src/app/(buyer)/dashboard/page.tsx`:
```tsx
import Link from 'next/link'
import { requireBuyer } from '@/server/session'
import { getSaleForBuyer, summariseSale } from '@/server/services/sales'
import { deriveStatus } from '@/domain/status'
import { formatMinor } from '@/domain/currency'
import { Card, PageHeader } from '@/components/ui'
import { StatusBadge } from '@/components/StatusBadge'

const date = (d: Date) => d.toISOString().slice(0, 10)

export default async function BuyerDashboard() {
  const actor = await requireBuyer()
  const sale = await getSaleForBuyer(actor)

  if (!sale) {
    return (
      <Card>
        <p className="text-sm text-slate-500">You do not have a unit yet.</p>
      </Card>
    )
  }

  const asOf = new Date()
  const summary = summariseSale(sale, asOf)
  const money = (amount: bigint) => formatMinor(amount, sale.currency)
  const statement = sale.documents.find((d) => d.type === 'STATEMENT')

  return (
    <>
      <PageHeader
        title={`Unit ${sale.unit.name}`}
        subtitle={`${sale.project.name} · ${sale.project.location}`}
      />

      <div className="mb-5 grid grid-cols-2 gap-3">
        <Card>
          <p className="text-xs text-slate-500">Paid to date</p>
          <p className="text-lg font-semibold text-emerald-700">{money(summary.paidToDateMinor)}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">Balance</p>
          <p className="text-lg font-semibold">{money(summary.balanceMinor)}</p>
        </Card>
        <Card className="col-span-2">
          <p className="text-xs text-slate-500">Next payment due</p>
          {summary.nextDue ? (
            <p className="text-lg font-semibold">
              {money(summary.nextDue.amountMinor)}{' '}
              <span className="text-sm font-normal text-slate-500">
                on {date(summary.nextDue.dueDate)}
              </span>
            </p>
          ) : (
            <p className="text-lg font-semibold text-emerald-700">Fully paid</p>
          )}
          {summary.overdueCount > 0 ? (
            <p className="mt-1 text-sm text-rose-700">
              {summary.overdueCount} payment{summary.overdueCount === 1 ? '' : 's'} overdue
            </p>
          ) : null}
        </Card>
      </div>

      {statement ? (
        <Link
          href={`/api/documents/${statement.id}`}
          className="mb-5 inline-block text-sm font-medium underline"
        >
          Download my payment statement (PDF)
        </Link>
      ) : null}

      <h2 className="mb-2 mt-6 font-semibold">Payment schedule</h2>
      <Card className="p-0">
        <ul className="divide-y divide-slate-100">
          {sale.scheduleEntries.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 p-3">
              <div>
                <p className="text-sm font-medium">
                  {entry.sequence}. {date(entry.dueDate)}
                </p>
                <p className="text-xs text-slate-500">
                  {money(entry.amountPaidMinor)} of {money(entry.amountDueMinor)} paid
                </p>
              </div>
              <StatusBadge status={deriveStatus(entry, asOf)} />
            </li>
          ))}
        </ul>
      </Card>

      <h2 className="mb-2 mt-6 font-semibold">Payment history</h2>
      {sale.payments.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">No payments recorded yet.</p>
        </Card>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-slate-100">
            {sale.payments.map((payment) => (
              <li key={payment.id} className="flex items-center justify-between gap-3 p-3">
                <div>
                  <p className={`text-sm font-medium ${payment.voidedAt ? 'text-slate-400 line-through' : ''}`}>
                    {money(payment.amountMinor)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {date(payment.receivedAt)} · {payment.method.replace(/_/g, ' ').toLowerCase()}
                    {payment.reference ? ` · ${payment.reference}` : ''}
                  </p>
                  {payment.voidedAt ? <p className="text-xs text-rose-700">Voided</p> : null}
                </div>
                {payment.document ? (
                  <Link href={`/api/documents/${payment.document.id}`} className="text-sm underline">
                    Receipt
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}
```

- [ ] **Step 2: Verify against seeded buyers**

Sign in as each seeded buyer and confirm: Amina shows fully paid with no next due; Kwame shows five paid and a future next due; Zainab shows a partial; Joseph shows an overdue count greater than zero. Confirm every amount renders in that project's currency.

Then sign in as Amina and request Joseph's document id directly at `/api/documents/<id>`. Expected: `404`, not a PDF.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(buyer)"
git commit -m "feat(ui): buyer dashboard with balance, next due, schedule and receipts"
```

---

### Task 22: Staff sale view, payment recording, and arrears report

**Files:**
- Create: `src/app/(staff)/sales/[id]/page.tsx`, `src/app/(staff)/sales/[id]/actions.ts`, `src/app/(staff)/sales/[id]/PaymentForm.tsx`, `src/app/(staff)/arrears/page.tsx`

**Interfaces:**
- Consumes: `getSaleForStaff`, `recordPayment`, `voidPayment`, `issueInvoice`, `arrearsReport`, `summariseSale`, `deriveStatus`, `daysLate`.

- [ ] **Step 1: Create the staff actions**

`src/app/(staff)/sales/[id]/actions.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireStaff, requireAdmin } from '@/server/session'
import { RecordPaymentSchema, recordPayment, voidPayment } from '@/server/services/payments'
import { issueInvoice } from '@/server/documents/issue'
import { ServiceError } from '@/server/services/errors'
import { formatMinor } from '@/domain/currency'
import { prisma } from '@/server/db'

export async function recordPaymentAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireStaff()
  const parsed = RecordPaymentSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Please check the payment details.'

  try {
    const { overpaymentMinor } = await recordPayment(actor, parsed.data)
    revalidatePath(`/sales/${parsed.data.saleId}`)

    if (overpaymentMinor > 0n) {
      const sale = await prisma.sale.findUniqueOrThrow({
        where: { id: parsed.data.saleId },
        select: { currency: true }
      })
      // Surfaced, never silently absorbed.
      return `Recorded. ${formatMinor(overpaymentMinor, sale.currency)} exceeded the outstanding balance and was not allocated.`
    }
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not record the payment.'
  }
}

export async function voidPaymentAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireAdmin()
  try {
    await voidPayment(actor, String(formData.get('paymentId') ?? ''), String(formData.get('reason') ?? ''))
    revalidatePath(`/sales/${String(formData.get('saleId') ?? '')}`)
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not void the payment.'
  }
}

export async function issueInvoiceAction(_prev: string | undefined, formData: FormData) {
  const actor = await requireStaff()
  try {
    await issueInvoice(actor, String(formData.get('scheduleEntryId') ?? ''))
    revalidatePath(`/sales/${String(formData.get('saleId') ?? '')}`)
  } catch (error) {
    return error instanceof ServiceError ? error.message : 'Could not issue the invoice.'
  }
}
```

- [ ] **Step 2: Create the sale view**

`src/app/(staff)/sales/[id]/page.tsx` renders, using `getSaleForStaff` and `summariseSale`:

- A header with buyer name, phone (as a `tel:` link — staff chase arrears by phone), unit and project.
- Three summary cards: paid to date, balance, next due.
- `PaymentForm` (client): amount, date received (defaulting to today), method select, reference, note, plus a hidden `saleId`. On submit it shows the returned message, including the overpayment notice.
- The schedule table: sequence, due date, amount, paid, `StatusBadge`, and per row either an "Invoice" download link when a document exists or an "Issue invoice" button.
- Payment history with a Receipt link per payment, and — for ADMIN only — a Void control that requires a reason before it submits.

- [ ] **Step 3: Create the arrears report**

`src/app/(staff)/arrears/page.tsx`:
```tsx
import Link from 'next/link'
import { requireStaff } from '@/server/session'
import { arrearsReport } from '@/server/services/arrears'
import { formatMinor } from '@/domain/currency'
import { Card, PageHeader } from '@/components/ui'

export default async function ArrearsPage() {
  const actor = await requireStaff()
  const asOf = new Date()
  const rows = await arrearsReport(actor, asOf)

  const total = rows.length

  return (
    <>
      <PageHeader
        title="Arrears"
        subtitle={
          total === 0
            ? 'No buyers are currently overdue.'
            : `${total} buyer${total === 1 ? '' : 's'} overdue as of ${asOf.toISOString().slice(0, 10)}`
        }
      />

      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.saleId}>
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Link href={`/sales/${row.saleId}`} className="font-medium underline">
                    {row.buyerName}
                  </Link>
                  <p className="text-sm text-slate-500">
                    {row.projectName} · Unit {row.unitName}
                  </p>
                  <a href={`tel:${row.buyerPhone}`} className="text-sm text-slate-700 underline">
                    {row.buyerPhone}
                  </a>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-rose-700">
                    {formatMinor(row.overdueAmountMinor, row.currency)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {row.overdueCount} installment{row.overdueCount === 1 ? '' : 's'}
                  </p>
                  <p className="text-xs text-rose-700">{row.daysLate} days late</p>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  )
}
```

- [ ] **Step 4: Verify the whole loop end to end**

As the agent, open Joseph Otieno's sale from the arrears page. Record a payment large enough to clear two overdue installments at once. Confirm:

- Two installments flip to Paid and the third becomes Partial — the cascade working against real rows.
- A receipt PDF is downloadable and lists both installments under "Applied to".
- Joseph disappears from the arrears report (or his figures drop) on reload.
- Recording a payment larger than the total balance returns the overpayment message rather than silently absorbing it.

As admin, void that payment. Confirm the balances revert exactly, the receipt is marked VOID, and Joseph reappears in arrears.

- [ ] **Step 5: Full verification before shipping**

```bash
npm test
npm run typecheck
npm run build
```
Expected: all suites pass, no type errors, clean production build.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)"
git commit -m "feat(ui): staff sale view, payment recording, void, and arrears report"
```

---

### Task 23: Admin manages sales agents

Coverage gap caught in review: the design gives ADMIN "agent management", and the seed creates an agent, but nothing in the app lets an admin add one. Without this, a real developer signing up has no way to give their sales team access.

**Files:**
- Create: `src/server/services/team.ts`, `src/app/(staff)/team/page.tsx`, `src/app/(staff)/team/actions.ts`
- Modify: `src/app/(staff)/layout.tsx` (add a Team link, ADMIN only)
- Test: `src/server/__tests__/team.test.ts`

**Interfaces:**
- Consumes: `prisma`, `assertRole`, `bcrypt`.
- Produces:
  - `CreateAgentSchema`
  - `createAgent(actor, input): Promise<{ userId: string }>`
  - `listTeam(actor)`
  - `deactivateAgent(actor, userId)`

- [ ] **Step 1: Write the failing test**

`src/server/__tests__/team.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { CreateAgentSchema } from '@/server/services/team'

const valid = { fullName: 'Tunde Bakare', email: 'tunde@sunrise.test', password: 'password123' }

describe('CreateAgentSchema', () => {
  it('accepts a valid agent', () => {
    expect(CreateAgentSchema.safeParse(valid).success).toBe(true)
  })

  it('lowercases the email', () => {
    expect(CreateAgentSchema.parse({ ...valid, email: 'Tunde@Sunrise.TEST' }).email)
      .toBe('tunde@sunrise.test')
  })

  it('requires a password of at least 8 characters', () => {
    expect(CreateAgentSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false)
  })

  it('rejects an invalid email', () => {
    expect(CreateAgentSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false)
  })

  it('rejects a blank name', () => {
    expect(CreateAgentSchema.safeParse({ ...valid, fullName: ' ' }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- team
```
Expected: FAIL, `Cannot find module '@/server/services/team'`.

- [ ] **Step 3: Implement `src/server/services/team.ts`**

```ts
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '@/server/db'
import { assertRole, type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'

export const CreateAgentSchema = z.object({
  fullName: z.string().trim().min(2, 'Name is required').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(8, 'Use at least 8 characters')
})

export type CreateAgentInput = z.infer<typeof CreateAgentSchema>

export async function createAgent(actor: SessionActor, input: CreateAgentInput) {
  assertRole(actor, ['ADMIN'])

  const existing = await prisma.user.findUnique({ where: { email: input.email } })
  if (existing) throw new ServiceError('That email is already in use', 'CONFLICT')

  const user = await prisma.user.create({
    data: {
      // The agent joins the admin's organisation, taken from the session —
      // never from the form, or an admin could plant a user in another tenant.
      orgId: actor.orgId,
      email: input.email,
      passwordHash: await bcrypt.hash(input.password, 10),
      fullName: input.fullName,
      role: 'AGENT'
    }
  })

  return { userId: user.id }
}

export async function listTeam(actor: SessionActor) {
  assertRole(actor, ['ADMIN'])
  return prisma.user.findMany({
    where: { orgId: actor.orgId, role: { in: ['ADMIN', 'AGENT'] } },
    orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
    select: { id: true, fullName: true, email: true, role: true, createdAt: true }
  })
}

export async function deactivateAgent(actor: SessionActor, userId: string) {
  assertRole(actor, ['ADMIN'])
  if (userId === actor.userId) throw new ServiceError('You cannot remove your own account')

  const user = await prisma.user.findFirst({
    where: { id: userId, orgId: actor.orgId, role: 'AGENT' }
  })
  if (!user) throw new ServiceError('Agent not found', 'NOT_FOUND')

  // Sales reference recordedByUserId, so the row is kept and the login is
  // disabled by replacing the hash with one no input can produce.
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: `disabled:${crypto.randomUUID()}` }
  })
}
```

- [ ] **Step 4: Implement the page and action**

`src/app/(staff)/team/actions.ts` exposes `createAgentAction` following the same `useFormState` shape as `createProjectAction`: parse with `CreateAgentSchema`, return the first issue message on failure, call `createAgent`, then `revalidatePath('/team')`.

`src/app/(staff)/team/page.tsx` calls `requireAdmin()` and `listTeam(actor)`, renders each member as a card showing name, email and a role pill, and puts a "Add sales agent" form (full name, email, temporary password) above the list. Add a hint under the password field: *"Share this with your agent — they can sign in with it immediately."*

Add to `src/app/(staff)/layout.tsx`, inside the nav and only when `actor.role === 'ADMIN'`:

```tsx
{actor.role === 'ADMIN' ? <Link href="/team">Team</Link> : null}
```

- [ ] **Step 5: Verify tenancy isolation**

```bash
npm test -- team
npm run dev
```
As admin, add an agent, sign out, and sign in as that agent. Confirm the agent can view projects, open a sale and record a payment, but sees no Team link and gets refused at `/team`. Confirm the new agent's `orgId` matches the admin's:

```bash
npx tsx -e "import{prisma}from'./src/server/db';prisma.user.findMany({select:{email:true,role:true,orgId:true}}).then(r=>console.table(r))"
```

- [ ] **Step 6: Commit**

```bash
git add src/server/services/team.ts "src/app/(staff)/team" "src/app/(staff)/layout.tsx" src/server/__tests__/team.test.ts
git commit -m "feat(team): admin can add and disable sales agents within their organisation"
```

---

## Deployment notes

Set in Vercel (Production and Preview): `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, `CRON_SECRET`. Vercel injects the `Authorization: Bearer $CRON_SECRET` header on cron invocations automatically once the variable exists.

`npm run build` runs `prisma generate` first — Vercel caches `node_modules`, and a stale client is the usual cause of a green local build failing in CI.

After the first deploy, trigger the cron path manually with the secret and confirm the tally, then confirm a second call reports the same jobs as `skipped`.

Also set `DIRECT_URL` — Neon's unpooled endpoint, the same URL with `-pooler` removed from the host. It is the `directUrl` in `schema.prisma` and is what `prisma db push` and any future migration use: DDL cannot run through PgBouncer, so a deployment without it cannot apply schema changes even though ordinary application queries (which go through the pooled `DATABASE_URL`) work fine.
