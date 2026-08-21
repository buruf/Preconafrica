import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The boundary between a developer's session and a platform operator's.
 *
 * These are the tests that matter most in the console. A platform admin has no
 * organisation, and every query in this app is scoped by one taken from the
 * session — so the failure this file exists to prevent is a platform token
 * being read as a developer's, arriving at an org-scoped query with no org,
 * and returning every tenant's rows.
 */

const authMock = vi.fn()
vi.mock('@/server/auth', () => ({ auth: authMock }))

const redirectMock = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`)
})
vi.mock('next/navigation', () => ({ redirect: redirectMock }))

vi.mock('@/server/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    platformUser: { findUnique: vi.fn() }
  }
}))

const { prisma } = await import('@/server/db')
const { requireUserOrNull, requirePlatformAdminOrNull, resolveSession } = await import('@/server/session')

const LIVE_USER = { disabledAt: null, passwordChangedAt: null, org: { suspendedAt: null } }

function session(overrides: Record<string, unknown>) {
  return {
    user: {
      id: 'u1',
      email: 'a@b.test',
      name: 'Adaeze',
      orgId: 'org_1',
      role: 'ADMIN',
      buyerId: null,
      kind: 'user',
      tokenIssuedAt: 2_000,
      ...overrides
    }
  }
}

beforeEach(() => {
  vi.mocked(prisma.user.findUnique).mockResolvedValue(LIVE_USER as never)
  vi.mocked(prisma.platformUser.findUnique).mockResolvedValue({
    disabledAt: null,
    passwordChangedAt: null
  } as never)
})

describe('a platform token cannot act as a developer', () => {
  it('is refused by requireUserOrNull', async () => {
    authMock.mockResolvedValue(session({ kind: 'platform', orgId: undefined }))
    expect(await requireUserOrNull()).toBeNull()
  })

  it('is refused before the user table is ever consulted', async () => {
    // The ordering is the point: if the discriminator were checked after the
    // lookup, a platform id colliding with a user id would resolve to that
    // user — and worse, the query would have run at all.
    authMock.mockResolvedValue(session({ kind: 'platform', orgId: undefined }))
    await requireUserOrNull()
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
  })
})

describe('a developer token cannot act as the platform', () => {
  it('is refused by requirePlatformAdminOrNull', async () => {
    authMock.mockResolvedValue(session({ kind: 'user' }))
    expect(await requirePlatformAdminOrNull()).toBeNull()
  })

  it('is refused even for an ADMIN of an organisation', async () => {
    authMock.mockResolvedValue(session({ kind: 'user', role: 'ADMIN' }))
    expect(await requirePlatformAdminOrNull()).toBeNull()
    expect(prisma.platformUser.findUnique).not.toHaveBeenCalled()
  })

  it('treats a token with no kind at all as a developer, never as the platform', async () => {
    // Tokens minted before `kind` existed carry none. They must keep working as
    // developer sessions and must never be promoted.
    authMock.mockResolvedValue(session({ kind: undefined }))
    expect(await requirePlatformAdminOrNull()).toBeNull()
    expect(await requireUserOrNull()).not.toBeNull()
  })
})

describe('a suspended organisation', () => {
  it('locks out an ADMIN', async () => {
    authMock.mockResolvedValue(session({ role: 'ADMIN' }))
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...LIVE_USER,
      org: { suspendedAt: new Date('2026-08-18T00:00:00Z') }
    } as never)
    expect(await requireUserOrNull()).toBeNull()
  })

  it('locks out an AGENT', async () => {
    authMock.mockResolvedValue(session({ role: 'AGENT' }))
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...LIVE_USER,
      org: { suspendedAt: new Date('2026-08-18T00:00:00Z') }
    } as never)
    expect(await requireUserOrNull()).toBeNull()
  })

  it('does NOT lock out a buyer', async () => {
    // The developer's dispute with the platform is not the buyer's dispute:
    // the receipts for a flat they are paying for stay downloadable.
    authMock.mockResolvedValue(session({ role: 'BUYER', buyerId: 'b1' }))
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...LIVE_USER,
      org: { suspendedAt: new Date('2026-08-18T00:00:00Z') }
    } as never)
    const actor = await requireUserOrNull()
    expect(actor?.role).toBe('BUYER')
  })

  it('still lets staff in when the organisation is not suspended', async () => {
    authMock.mockResolvedValue(session({ role: 'AGENT' }))
    expect((await requireUserOrNull())?.role).toBe('AGENT')
  })
})

describe('a platform admin is revoked like any other account', () => {
  it('is refused once deactivated', async () => {
    authMock.mockResolvedValue(session({ kind: 'platform', orgId: undefined }))
    vi.mocked(prisma.platformUser.findUnique).mockResolvedValue({
      disabledAt: new Date('2026-08-18T00:00:00Z'),
      passwordChangedAt: null
    } as never)
    expect(await requirePlatformAdminOrNull()).toBeNull()
  })

  it('is refused when the session predates a password change', async () => {
    authMock.mockResolvedValue(session({ kind: 'platform', orgId: undefined, tokenIssuedAt: 1_000 }))
    vi.mocked(prisma.platformUser.findUnique).mockResolvedValue({
      disabledAt: null,
      passwordChangedAt: new Date(2_000 * 1000)
    } as never)
    expect(await requirePlatformAdminOrNull()).toBeNull()
  })

  it('is admitted when live and current', async () => {
    authMock.mockResolvedValue(session({ kind: 'platform', orgId: undefined }))
    const admin = await requirePlatformAdminOrNull()
    expect(admin).toMatchObject({ userId: 'u1', kind: 'platform' })
  })
})

describe('a suspended organisation tells its staff why', () => {
  const SUSPENDED = {
    disabledAt: null,
    passwordChangedAt: null,
    org: {
      suspendedAt: new Date('2026-08-18T00:00:00Z'),
      suspensionReason: 'Subscription unpaid since June.'
    }
  }

  it('reports suspension distinctly from being signed out', async () => {
    // The whole point: staff who cannot sign in also cannot read their audit
    // log, so being bounced to /login with no explanation leaves them with no
    // way to find out. The caller needs to tell these two apart.
    authMock.mockResolvedValue(session({ role: 'ADMIN' }))
    vi.mocked(prisma.user.findUnique).mockResolvedValue(SUSPENDED as never)

    const outcome = await resolveSession()
    expect(outcome.kind).toBe('suspended')
    if (outcome.kind === 'suspended') {
      expect(outcome.reason).toBe('Subscription unpaid since June.')
      expect(outcome.since).toEqual(new Date('2026-08-18T00:00:00Z'))
    }
  })

  it('reports a suspension with no reason as suspended all the same', async () => {
    authMock.mockResolvedValue(session({ role: 'AGENT' }))
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...SUSPENDED,
      org: { ...SUSPENDED.org, suspensionReason: null }
    } as never)

    const outcome = await resolveSession()
    expect(outcome.kind).toBe('suspended')
    if (outcome.kind === 'suspended') expect(outcome.reason).toBeNull()
  })

  it('does not report a buyer as suspended, because they are not', async () => {
    authMock.mockResolvedValue(session({ role: 'BUYER', buyerId: 'b1' }))
    vi.mocked(prisma.user.findUnique).mockResolvedValue(SUSPENDED as never)

    const outcome = await resolveSession()
    expect(outcome.kind).toBe('actor')
  })

  it('still returns null from requireUserOrNull, so API routes answer 401', async () => {
    // A suspended developer's staff must not keep pulling PDFs. The richer
    // outcome is for pages, which can navigate; a route handler cannot.
    authMock.mockResolvedValue(session({ role: 'ADMIN' }))
    vi.mocked(prisma.user.findUnique).mockResolvedValue(SUSPENDED as never)
    expect(await requireUserOrNull()).toBeNull()
  })

  it('reports an unauthenticated visitor as unauthenticated, not suspended', async () => {
    authMock.mockResolvedValue(null)
    expect((await resolveSession()).kind).toBe('unauthenticated')
  })
})
