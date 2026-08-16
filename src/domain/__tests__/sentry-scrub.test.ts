import { describe, expect, it } from 'vitest'
import { REDACTED, scrubEvent, type ScrubbableEvent } from '@/domain/sentry-scrub'

/**
 * The scrubber, tested as the pure function it is rather than trusted as
 * configuration. A `beforeSend` that has never been called is a hypothesis.
 *
 * Two halves matter equally. Everything sensitive must go — a connection
 * string, a blob token, the session cookie, a password field, a live reset
 * token — and everything else must survive, because a scrubber that redacts
 * the unit id and the route has removed the only reason to send the report.
 */

/** Everything in the event, flattened, so nothing can hide at depth. */
function serialise(event: unknown): string {
  return JSON.stringify(event)
}

const DATABASE_URL =
  'postgresql://neondb_owner:npg_S3cr3tPassw0rd@ep-dry-block-ax492ypx.c-4.us-east-2.aws.neon.tech/neondb?sslmode=require'
const BLOB_TOKEN = 'vercel_blob_rw_ABC123xyz_deadbeefcafe'
const SESSION_COOKIE =
  '__Secure-authjs.session-token=eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..abcdef; Path=/'

describe('scrubEvent removes what must never leave the process', () => {
  it('removes a connection string from an exception message', () => {
    // The likeliest way one escapes: not under a key called DATABASE_URL, but
    // in the middle of a Prisma error.
    const event = scrubEvent({
      exception: {
        values: [
          {
            type: 'PrismaClientInitializationError',
            value: `Can't reach database server at ${DATABASE_URL}`
          }
        ]
      }
    })

    expect(serialise(event)).not.toContain('npg_S3cr3tPassw0rd')
    expect(serialise(event)).not.toContain('ep-dry-block-ax492ypx')
    expect(serialise(event)).toContain('[redacted connection string]')
  })

  it('removes a connection string with no credentials in it', () => {
    const event = scrubEvent({ message: 'connecting to postgres://host.neon.tech/neondb' })
    expect(serialise(event)).not.toContain('host.neon.tech')
  })

  it('removes a connection string wherever it is nested', () => {
    const event = scrubEvent({
      contexts: { runtime: { env: { readable: { deeply: { nested: DATABASE_URL } } } } }
    })
    expect(serialise(event)).not.toContain('npg_S3cr3tPassw0rd')
  })

  it('removes BLOB_READ_WRITE_TOKEN, both as a name and as a bare value', () => {
    const event = scrubEvent({
      extra: { BLOB_READ_WRITE_TOKEN: BLOB_TOKEN },
      message: `upload failed with BLOB_READ_WRITE_TOKEN=${BLOB_TOKEN}`,
      breadcrumbs: [{ message: `token was ${BLOB_TOKEN}` }]
    })

    expect(serialise(event)).not.toContain('ABC123xyz')
    expect(serialise(event)).not.toContain('deadbeefcafe')
  })

  it('removes the session cookie from request headers', () => {
    const event = scrubEvent({
      request: {
        url: 'https://precon.test/sales/sale_1',
        headers: {
          'user-agent': 'Mozilla/5.0',
          cookie: SESSION_COOKIE,
          Cookie: SESSION_COOKIE,
          authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature'
        }
      }
    })

    expect(serialise(event)).not.toContain('eyJhbGciOiJkaXIi')
    expect(serialise(event)).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    // The harmless header is still there — the point is a usable report.
    expect(event.request?.headers?.['user-agent']).toBe('Mozilla/5.0')
  })

  it('removes the cookies object outright', () => {
    const event = scrubEvent({
      request: { cookies: { 'authjs.session-token': 'eyJhbGciOiJkaXIi.abc' } }
    })
    expect(event.request && 'cookies' in event.request).toBe(false)
    expect(serialise(event)).not.toContain('eyJhbGciOiJkaXIi')
  })

  it('removes a session cookie serialised into a plain string', () => {
    const event = scrubEvent({ message: `Set-Cookie: ${SESSION_COOKIE}` })
    expect(serialise(event)).not.toContain('eyJhbGciOiJkaXIi')
  })

  it('removes password fields from a submitted form body', () => {
    const event = scrubEvent({
      request: {
        data: {
          email: 'admin@sunrise.test',
          password: 'password123',
          currentPassword: 'password123',
          confirmation: 'password123'
        }
      }
    })

    const body = (event.request?.data ?? {}) as Record<string, unknown>
    expect(body.password).toBe(REDACTED)
    expect(body.currentPassword).toBe(REDACTED)
    // Not every spelling is caught by name, which is why the value pass exists
    // — but the two that name themselves must never survive.
    expect(serialise({ password: body.password, current: body.currentPassword })).not.toContain(
      'password123'
    )
  })

  it('removes a live reset token from a URL, and keeps the path that identifies the bug', () => {
    const event = scrubEvent({
      request: {
        url: 'https://precon.test/reset-password?token=Zm9vYmFyYmF6cXV4LXNlY3JldA&from=email'
      },
      breadcrumbs: [
        { category: 'navigation', data: { to: '/reset-password?token=Zm9vYmFyYmF6cXV4LXNlY3JldA' } }
      ]
    })

    expect(serialise(event)).not.toContain('Zm9vYmFyYmF6cXV4LXNlY3JldA')
    expect(event.request?.url).toContain('/reset-password')
    expect(event.request?.url).toContain('from=email')
  })

  it('removes a reset token carried as a form field', () => {
    const event = scrubEvent({ request: { data: { token: 'Zm9vYmFyYmF6cXV4LXNlY3JldA' } } })
    expect(serialise(event)).not.toContain('Zm9vYmFyYmF6cXV4LXNlY3JldA')
  })

  it('removes the other secrets this app is started with', () => {
    const event = scrubEvent({
      message:
        'env check failed: NEXTAUTH_SECRET=abc123secret CRON_SECRET=def456secret RESEND_API_KEY=re_live_789',
      extra: { NEXTAUTH_SECRET: 'abc123secret', CRON_SECRET: 'def456secret' }
    })

    const serialised = serialise(event)
    expect(serialised).not.toContain('abc123secret')
    expect(serialised).not.toContain('def456secret')
    expect(serialised).not.toContain('re_live_789')
  })

  it('does not attach who the user was', () => {
    // Default off, deliberately: a buyer's name and email in a stack trace is
    // a judgement call and this one is made in the negative. See the comment
    // on scrubEvent.
    const event = scrubEvent({
      user: { id: 'usr_1', email: 'kwame@buyer.test', username: 'Kwame Mensah' }
    })
    expect(event.user).toBeUndefined()
    expect(serialise(event)).not.toContain('kwame@buyer.test')
  })
})

describe('scrubEvent leaves a usable report behind', () => {
  it('keeps the ordinary fields that make a report worth sending', () => {
    const event = scrubEvent({
      request: {
        url: 'https://precon.test/projects/prj_1/sell/unit_4/confirm',
        method: 'POST',
        headers: { 'user-agent': 'Mozilla/5.0', 'content-type': 'multipart/form-data' },
        data: { unitId: 'unit_4', planType: 'INSTALLMENTS', termMonths: '24', deposit: '2500000' }
      },
      tags: { route: '/projects/[id]/sell/[unitId]/confirm', runtime: 'nodejs' },
      extra: { orgId: 'org_1', currency: 'NGN', amountMinor: '250000000' },
      exception: { values: [{ type: 'TypeError', value: 'Cannot read properties of undefined' }] }
    })

    expect(event.request?.url).toBe(
      'https://precon.test/projects/prj_1/sell/unit_4/confirm'
    )
    expect(event.request?.method).toBe('POST')
    expect(event.request?.data).toEqual({
      unitId: 'unit_4',
      planType: 'INSTALLMENTS',
      termMonths: '24',
      deposit: '2500000'
    })
    expect(event.tags).toEqual({
      route: '/projects/[id]/sell/[unitId]/confirm',
      runtime: 'nodejs'
    })
    expect(event.extra).toEqual({ orgId: 'org_1', currency: 'NGN', amountMinor: '250000000' })
    expect(serialise(event.exception)).toContain('Cannot read properties of undefined')
  })

  it('leaves non-string scalars alone', () => {
    const event = scrubEvent({
      extra: { count: 42, ok: false, missing: null, level: 'error' }
    })
    expect(event.extra).toEqual({ count: 42, ok: false, missing: null, level: 'error' })
  })

  it('does not mutate the event it was given', () => {
    const original: ScrubbableEvent = {
      request: { data: { password: 'password123' }, cookies: { a: 'b' } }
    }
    scrubEvent(original)
    expect((original.request?.data as Record<string, unknown>).password).toBe('password123')
    expect(original.request?.cookies).toEqual({ a: 'b' })
  })

  it('terminates on a deeply nested graph instead of running away', () => {
    let deep: Record<string, unknown> = { leaf: DATABASE_URL }
    for (let i = 0; i < 60; i += 1) deep = { nested: deep }
    const event = scrubEvent({ extra: deep })
    expect(serialise(event)).not.toContain('npg_S3cr3tPassw0rd')
  })
})
