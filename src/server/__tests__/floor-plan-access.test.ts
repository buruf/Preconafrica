import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionActor } from '@/server/session'
import { extractPdfText } from '@/server/__tests__/pdf-fixtures'

/**
 * Who may download which unit's floor plan.
 *
 * This is the one part of the feature that can leak something. The route hands
 * out a document derived from a unit, and there are two different scopes behind
 * one URL:
 *
 *  - staff see any unit in their own organisation;
 *  - a buyer sees only the unit that is the subject of *their own* sale.
 *
 * The second is the case worth a test of its own. Every buyer in a developer's
 * organisation shares its `orgId`, so scoping by the project's org alone —
 * which is exactly what the staff branch does, and exactly what a careless
 * refactor would collapse the two branches into — would let any buyer read any
 * other buyer's floor plan by editing an id into the URL.
 *
 * The fake prisma below is a real matcher over a real fixture set rather than a
 * `mockResolvedValue`, because the property under test *is* the `where` clause:
 * a mock that returns a row regardless of what it was asked would pass whatever
 * the route did.
 *
 * `@/server/pdf/floor-plan` is deliberately NOT mocked. The allowed cases run
 * the genuine renderer against the same fake unit rows, so this file also pins
 * the property that matters most about the document's content: the unit row
 * carries a `priceMinor`, and none of it reaches the page.
 */

interface FakeUnit {
  id: string
  orgId: string
  buyerId: string | null
  name: string
  floor: number
  bedrooms: number
  sizeSqm: { toString(): string }
  /** Present, and deliberately never rendered — see the no-money case below. */
  priceMinor: bigint
  layoutImageUrl: string | null
}

const UNITS: FakeUnit[] = [
  {
    id: 'unit_kwame',
    orgId: 'org_sunrise',
    buyerId: 'buyer_kwame',
    name: '3B',
    floor: 3,
    bedrooms: 3,
    sizeSqm: { toString: () => '245.00' },
    priceMinor: 14500000000n,
    layoutImageUrl: null
  },
  {
    id: 'unit_ama',
    orgId: 'org_sunrise',
    buyerId: 'buyer_ama',
    name: '4B',
    floor: 4,
    bedrooms: 4,
    sizeSqm: { toString: () => '260.00' },
    priceMinor: 16000000000n,
    layoutImageUrl: null
  },
  {
    id: 'unit_unsold',
    orgId: 'org_sunrise',
    buyerId: null,
    name: '5A',
    floor: 5,
    bedrooms: 2,
    sizeSqm: { toString: () => '120.00' },
    priceMinor: 9000000000n,
    layoutImageUrl: null
  },
  {
    id: 'unit_other_org',
    orgId: 'org_rival',
    buyerId: null,
    name: '1A',
    floor: 1,
    bedrooms: 1,
    sizeSqm: { toString: () => '60.00' },
    priceMinor: 4000000000n,
    layoutImageUrl: null
  }
]

/** The row shape both callers of `unit.findFirst` consume. */
function hydrate(unit: FakeUnit) {
  return {
    ...unit,
    project: {
      name: 'Sunrise Heights',
      location: 'Lekki Phase 1, Lagos',
      expectedCompletion: new Date('2028-06-30T00:00:00Z'),
      org: { name: 'Sunrise Developments', logoUrl: null }
    }
  }
}

/**
 * Applies the three clauses the route and the renderer actually build:
 * `id`, `project.orgId`, and — for a buyer only — `sale.buyerId`.
 */
interface UnitWhere {
  id: string
  project: { orgId: string }
  sale?: { buyerId: string }
}

vi.mock('@/server/db', () => ({
  prisma: {
    unit: {
      findFirst: vi.fn(async ({ where }: { where: UnitWhere }) => {
        const unit = UNITS.find((candidate) => candidate.id === where.id)
        if (!unit) return null
        if (unit.orgId !== where.project.orgId) return null
        if (where.sale && unit.buyerId !== where.sale.buyerId) return null
        return hydrate(unit)
      })
    }
  }
}))

const requireUserOrNull = vi.fn<() => Promise<SessionActor | null>>()
vi.mock('@/server/session', () => ({ requireUserOrNull: () => requireUserOrNull() }))

const { GET } = await import('@/app/api/units/[unitId]/floor-plan/route')

function actor(
  role: SessionActor['role'],
  buyerId: string | null = null,
  orgId = 'org_sunrise'
): SessionActor {
  return {
    userId: 'user_1',
    orgId,
    role,
    buyerId,
    fullName: 'Test User',
    email: 'test@sunrise.test'
  }
}

async function get(unitId: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/units/${unitId}/floor-plan`), {
    params: { unitId }
  })
}

beforeEach(() => {
  requireUserOrNull.mockReset()
})

describe('who may download a unit floor plan', () => {
  const CASES: Array<{
    name: string
    session: SessionActor | null
    unitId: string
    status: number
  }> = [
    {
      name: 'staff, a unit in their own organisation',
      session: actor('ADMIN'),
      unitId: 'unit_kwame',
      status: 200
    },
    {
      name: 'staff, an unsold unit in their own organisation (no sale exists yet)',
      session: actor('AGENT'),
      unitId: 'unit_unsold',
      status: 200
    },
    {
      name: 'staff, a unit in another organisation',
      session: actor('ADMIN'),
      unitId: 'unit_other_org',
      status: 404
    },
    {
      name: "a buyer, their own sale's unit",
      session: actor('BUYER', 'buyer_kwame'),
      unitId: 'unit_kwame',
      status: 200
    },
    {
      name: "a buyer, another buyer's unit in the same organisation",
      session: actor('BUYER', 'buyer_kwame'),
      unitId: 'unit_ama',
      status: 404
    },
    {
      name: 'a buyer, an unsold unit in their own organisation',
      session: actor('BUYER', 'buyer_kwame'),
      unitId: 'unit_unsold',
      status: 404
    },
    {
      name: 'a BUYER session carrying no buyerId at all',
      session: actor('BUYER', null),
      unitId: 'unit_kwame',
      status: 404
    },
    {
      name: 'signed out',
      session: null,
      unitId: 'unit_kwame',
      status: 401
    },
    {
      name: 'an id that names nothing',
      session: actor('ADMIN'),
      unitId: 'unit_does_not_exist',
      status: 404
    }
  ]

  it.each(CASES)('$name -> $status', async ({ session, unitId, status }) => {
    requireUserOrNull.mockResolvedValue(session)

    const response = await get(unitId)
    expect(response.status).toBe(status)
  })

  it('never answers 403, which would confirm a guessed id is real', async () => {
    for (const { session, unitId } of CASES) {
      requireUserOrNull.mockResolvedValue(session)
      expect((await get(unitId)).status).not.toBe(403)
    }
  })

  it('is indistinguishable between a refusal and a miss', async () => {
    requireUserOrNull.mockResolvedValue(actor('BUYER', 'buyer_kwame'))

    const refused = await get('unit_ama')
    const missing = await get('unit_does_not_exist')

    expect(refused.status).toBe(missing.status)
    expect(await refused.text()).toBe(await missing.text())
  })
})

describe('what an allowed download actually returns', () => {
  it('is a PDF, named after the unit, for staff', async () => {
    requireUserOrNull.mockResolvedValue(actor('ADMIN'))

    const response = await get('unit_kwame')
    const buffer = Buffer.from(await response.arrayBuffer())

    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Content-Disposition')).toContain('floor-plan-unit-3B.pdf')
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it("is the same document for the buyer whose sale it is", async () => {
    requireUserOrNull.mockResolvedValue(actor('BUYER', 'buyer_kwame'))

    const response = await get('unit_kwame')
    const text = extractPdfText(Buffer.from(await response.arrayBuffer()))

    expect(text).toContain('UNIT 3B')
    expect(text).toContain('245.00 m²')
    expect(text).toContain('Sunrise Developments')
  })

  it('carries no price, though the unit row it is built from has one', async () => {
    requireUserOrNull.mockResolvedValue(actor('BUYER', 'buyer_kwame'))

    const text = extractPdfText(Buffer.from(await (await get('unit_kwame')).arrayBuffer()))

    // NGN 145,000,000.00 is what `formatMinor` would have made of this unit's
    // priceMinor. Neither the code nor the grouped figure may appear: the unit's
    // current price and a signed sale's snapshot are different numbers, and this
    // one URL serves both staff and buyers.
    expect(text).not.toMatch(/\b(NGN|KES|USD)\b/)
    expect(text).not.toMatch(/\d{1,3}(,\d{3})+/)
    expect(text).not.toContain('145000000')
  })

  it('renders a valid document for a unit with no drawing uploaded', async () => {
    requireUserOrNull.mockResolvedValue(actor('AGENT'))

    const response = await get('unit_unsold')
    const buffer = Buffer.from(await response.arrayBuffer())

    expect(response.status).toBe(200)
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(extractPdfText(buffer)).toContain('NO FLOOR PLAN YET')
  })
})
