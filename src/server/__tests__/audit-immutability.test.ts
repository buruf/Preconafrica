import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AUDIT_MODEL,
  AuditImmutabilityError,
  auditImmutabilityMiddleware,
  refusesQuery
} from '@/server/audit/immutability'

/**
 * Immutability, proven rather than asserted.
 *
 * Two mechanisms hold "an audit entry is never updated and never deleted", and
 * this file exercises both as far as a test without a database can:
 *
 *   1. The Prisma middleware. It is a pure decision (`refusesQuery`) wrapped in
 *      three lines, so every operation Prisma exposes can be run through it
 *      here — including the ones a future Prisma version might add, via the
 *      exhaustive list below.
 *   2. The Postgres trigger. A unit test cannot fire a trigger, so what is
 *      checked here is that the SQL exists, that it covers all three ways rows
 *      can leave a table, and that it *raises* rather than silently doing
 *      nothing. The trigger itself is verified against the live Dev database.
 *
 * The middleware is the readable error; the trigger is the guarantee. Neither
 * is sufficient alone: the middleware binds only this process, and the trigger
 * only tells you after the round trip.
 */

const SQL = readFileSync(
  path.resolve(__dirname, '../../../prisma/audit-immutability.sql'),
  'utf8'
)

/** Every write operation Prisma's client exposes. */
const WRITES = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']
const READS = ['findFirst', 'findMany', 'findUnique', 'count', 'aggregate', 'groupBy']

describe('the Prisma guard refuses every way a row could change or vanish', () => {
  it.each(['update', 'updateMany', 'upsert', 'delete', 'deleteMany'])(
    'refuses AuditEntry.%s',
    (action) => {
      expect(refusesQuery(AUDIT_MODEL, action)).toBe(true)
    }
  )

  it.each(['create', 'createMany'])('allows AuditEntry.%s, because appending is the point', (action) => {
    expect(refusesQuery(AUDIT_MODEL, action)).toBe(false)
  })

  it.each(READS)('allows AuditEntry.%s', (action) => {
    expect(refusesQuery(AUDIT_MODEL, action)).toBe(false)
  })

  it('covers every write operation, so a new one cannot slip through unclassified', () => {
    // The exhaustive statement: of Prisma's seven writes, exactly the two that
    // append are allowed and the other five are refused. A future operation
    // added to WRITES fails this until somebody decides which side it is on.
    const refused = WRITES.filter((action) => refusesQuery(AUDIT_MODEL, action))
    expect(refused.sort()).toEqual(['delete', 'deleteMany', 'update', 'updateMany', 'upsert'])
  })

  it('leaves every other model alone', () => {
    for (const model of ['Payment', 'Sale', 'Unit', 'User', 'PasswordResetToken']) {
      for (const action of WRITES) {
        expect(refusesQuery(model, action), `${model}.${action} must not be refused`).toBe(false)
      }
    }
  })

  it('does not refuse a raw query, which carries no model', () => {
    expect(refusesQuery(undefined, 'executeRaw')).toBe(false)
  })
})

describe('the middleware', () => {
  it('throws before the query reaches the database', async () => {
    const next = vi.fn()

    await expect(
      auditImmutabilityMiddleware({ model: 'AuditEntry', action: 'deleteMany' }, next)
    ).rejects.toBeInstanceOf(AuditImmutabilityError)

    // The important half: `next` is what actually issues the query, and it was
    // never called. The row is not deleted-then-complained-about.
    expect(next).not.toHaveBeenCalled()
  })

  it('explains what to do instead, rather than only saying no', () => {
    const error = new AuditImmutabilityError('delete')
    expect(error.message).toContain('append-only')
    expect(error.message).toContain('AuditEntry.delete')
    expect(error.message).toMatch(/record a new entry/i)
  })

  it('passes an append straight through', async () => {
    const next = vi.fn(async () => ({ id: 'audit_1' }))

    await expect(
      auditImmutabilityMiddleware({ model: 'AuditEntry', action: 'create' }, next)
    ).resolves.toEqual({ id: 'audit_1' })
    expect(next).toHaveBeenCalledOnce()
  })

  it('passes another model’s delete straight through', async () => {
    const next = vi.fn(async () => ({ count: 3 }))

    await expect(
      auditImmutabilityMiddleware({ model: 'PasswordResetToken', action: 'deleteMany' }, next)
    ).resolves.toEqual({ count: 3 })
    expect(next).toHaveBeenCalledOnce()
  })

  it('is installed on the client that every service uses', () => {
    // The guard existing is worth nothing if nobody wires it in. This is the
    // wiring, asserted at the only place it happens.
    const source = readFileSync(path.resolve(__dirname, '../db.ts'), 'utf8')
    expect(source).toContain('auditImmutabilityMiddleware')
    expect(source).toContain('$use(')
  })
})

describe('the database trigger', () => {
  it('covers UPDATE, DELETE and TRUNCATE', () => {
    // TRUNCATE is the one people forget: it bypasses row-level triggers
    // entirely, so without its own statement-level trigger the table could be
    // emptied in silence while the other two looked like they were working.
    expect(SQL).toMatch(/BEFORE UPDATE ON "AuditEntry"/)
    expect(SQL).toMatch(/BEFORE DELETE ON "AuditEntry"/)
    expect(SQL).toMatch(/BEFORE TRUNCATE ON "AuditEntry"/)
  })

  it('holds the platform operator to the same standard', () => {
    // A platform admin can create and suspend developers. The record of having
    // done so must not be something they can quietly remove, so the separate
    // table gets the identical three triggers rather than a weaker promise.
    expect(SQL).toMatch(/BEFORE UPDATE ON "PlatformAuditEntry"/)
    expect(SQL).toMatch(/BEFORE DELETE ON "PlatformAuditEntry"/)
    expect(SQL).toMatch(/BEFORE TRUNCATE ON "PlatformAuditEntry"/)
  })

  it('raises rather than silently discarding the statement', () => {
    // A rule that does nothing would make a DELETE appear to succeed while
    // changing nothing, which is how somebody concludes the log is broken.
    expect(SQL).toContain('RAISE EXCEPTION')
    expect(SQL).not.toMatch(/DO INSTEAD NOTHING/i)
  })

  it('is idempotent, because it is re-applied after every schema push', () => {
    // `prisma db push` recreates tables and knows nothing about triggers, so
    // this file runs again on every push and must survive doing so.
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION')

    // Every trigger is dropped before it is created — the property, rather
    // than a count. This used to assert exactly 3, which meant adding a second
    // append-only table failed the test for being *more* protected. Comparing
    // the two totals keeps the guarantee and stops the number from being a
    // thing to remember.
    const drops = (SQL.match(/DROP TRIGGER IF EXISTS/g) ?? []).length
    const creates = (SQL.match(/CREATE TRIGGER/g) ?? []).length
    expect(creates).toBeGreaterThanOrEqual(3)
    expect(drops).toBe(creates)
  })

  it('is wired to run after every schema push', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')
    ) as { scripts: Record<string, string> }

    // Without this the triggers would be missing from every database the schema
    // is ever pushed to, including a fresh production one.
    expect(pkg.scripts['postdb:push']).toContain('ensure-audit-immutability')
  })
})

describe('nothing reaps the audit log', () => {
  it('is absent from the cron job that reaps everything else', () => {
    // The daily job purges spent reset tokens and closed rate-limit windows.
    // Adding audit entries to it by analogy is the mistake this guards.
    const cron = readFileSync(
      path.resolve(__dirname, '../../app/api/cron/reminders/route.ts'),
      'utf8'
    )

    expect(cron).not.toMatch(/auditEntry\s*\.\s*delete/i)
    expect(cron).not.toMatch(/purge\w*Audit/i)
    // And the reasoning is written where the mistake would be made.
    expect(cron).toContain('AuditEntry')
  })

  it('is never deleted anywhere in the application', () => {
    // The broadest form of the rule: no source file outside the tests may issue
    // a delete against this table. The trigger would refuse it at runtime; this
    // fails at build time instead.
    const source = readFileSync(
      path.resolve(__dirname, '../services/audit.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/auditEntry\.(delete|deleteMany|update|updateMany|upsert)/)
  })
})
