import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceError } from '@/server/services/errors'
import type { SessionActor } from '@/server/session'
import { auditRecorder } from './audit-fake'

/**
 * What `createProject` does with the unit positions it is handed.
 *
 * The schema tests next door prove the rows parse. This proves the thing that
 * actually matters to the owner: that row *i* lands on `indexOnFloor` *i* of
 * every floor, so a building with four different flats a floor comes out as
 * four different flats a floor rather than 64 copies of the first one.
 *
 * A recording fake for the transaction client, following record-payment.test.ts
 * — the rows handed to `unit.createMany` are the assertion, and they are only
 * visible from inside the transaction.
 */
vi.mock('@/server/db', () => ({
  prisma: {
    $transaction: vi.fn()
  }
}))

const { prisma } = await import('@/server/db')
const { createProject } = await import('@/server/services/projects')

const $transaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>

interface UnitRow {
  name: string
  floor: number
  bedrooms: number
  sizeSqm: string
  priceMinor: bigint
}

let createdUnits: UnitRow[] = []

const admin: SessionActor = {
  userId: 'user_1',
  orgId: 'org_1',
  role: 'ADMIN',
  buyerId: null,
  fullName: 'Adaeze Okonkwo',
  email: 'admin@sunrise.test'
}

const base = {
  name: 'Khaleel Suites',
  location: 'Kilimani, Nairobi',
  currency: 'KES',
  expectedCompletion: '2028-06-30',
  startFloor: 1,
  namingPattern: '{letter}{floor}{index:02}',
  heroImageUrl: null,
  installmentFeeMode: 'PERCENT' as const,
  installmentMarkupPercent: '0',
  installmentFixedFee: '0',
  reminderDaysBefore: 7,
  overdueNoticeDaysAfter: 3
}

/** The owner's real building: four positions, three distinct types. */
const KHALEEL_POSITIONS = [
  { bedrooms: 4, sizeSqm: '245.00', price: '18500000' },
  { bedrooms: 4, sizeSqm: '245.00', price: '18500000' },
  { bedrooms: 4, sizeSqm: '240.00', price: '18000000' },
  { bedrooms: 3, sizeSqm: '210.00', price: '15200000' }
]

/** The audit entries the transaction under test wrote. Reset per test. */
let audit = auditRecorder()

beforeEach(() => {
  createdUnits = []
  audit = auditRecorder()
  $transaction.mockReset()
  $transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      project: {
        // `name` and `currency` come back because the audit entry written in
        // the same transaction reads them off the created row rather than off
        // the input — the row is what actually landed.
        create: vi.fn(async () => ({ id: 'project_1', name: 'Khaleel Suites', currency: 'KES' }))
      },
      unit: {
        createMany: vi.fn(async ({ data }: { data: UnitRow[] }) => {
          createdUnits = data
          return { count: data.length }
        })
      },
      auditEntry: audit.auditEntry
    })
  )
})

const unitNamed = (name: string) => createdUnits.find((unit) => unit.name === name)

describe('createProject — a position per unit', () => {
  it('gives every position its own bedrooms, size and price, on every floor', async () => {
    const result = await createProject(admin, {
      ...base,
      floors: 16,
      unitsPerFloor: 4,
      unitTypes: KHALEEL_POSITIONS
    })

    expect(result.unitCount).toBe(64)
    expect(createdUnits).toHaveLength(64)

    // Floor 1, where an admin filling the form sees the names previewed.
    expect(unitNamed('A101')).toMatchObject({
      floor: 1,
      bedrooms: 4,
      sizeSqm: '245.00',
      priceMinor: 1850000000n
    })
    expect(unitNamed('B102')).toMatchObject({ bedrooms: 4, sizeSqm: '245.00' })
    // Position 3 differs from 1 and 2 only in size — exactly the distinction the
    // old single-default form could not express.
    expect(unitNamed('C103')).toMatchObject({
      bedrooms: 4,
      sizeSqm: '240.00',
      priceMinor: 1800000000n
    })
    expect(unitNamed('D104')).toMatchObject({
      floor: 1,
      bedrooms: 3,
      sizeSqm: '210.00',
      priceMinor: 1520000000n
    })

    // The top floor carries the same positions, which is the point: a row is a
    // position in the building, not a unit on floor one.
    expect(unitNamed('A1601')).toMatchObject({ floor: 16, bedrooms: 4, sizeSqm: '245.00' })
    expect(unitNamed('D1604')).toMatchObject({ floor: 16, bedrooms: 3, sizeSqm: '210.00' })

    // No unit anywhere got somebody else's figures.
    expect(createdUnits.filter((u) => u.bedrooms === 3)).toHaveLength(16)
    expect(createdUnits.filter((u) => u.sizeSqm === '240.00')).toHaveLength(16)
  })

  it('handles eight positions a floor, mixing 1-bed through 4-bed', async () => {
    const eight = [
      { bedrooms: 1, sizeSqm: '48.00', price: '5200000' },
      { bedrooms: 1, sizeSqm: '50.00', price: '5400000' },
      { bedrooms: 2, sizeSqm: '82.00', price: '8100000' },
      { bedrooms: 2, sizeSqm: '82.00', price: '8100000' },
      { bedrooms: 3, sizeSqm: '124.00', price: '11900000' },
      { bedrooms: 3, sizeSqm: '130.00', price: '12400000' },
      { bedrooms: 4, sizeSqm: '188.00', price: '16750000' },
      { bedrooms: 4, sizeSqm: '196.00', price: '17300000' }
    ]

    const result = await createProject(admin, {
      ...base,
      floors: 3,
      unitsPerFloor: 8,
      namingPattern: '{floor}{index:02}',
      unitTypes: eight
    })

    expect(result.unitCount).toBe(24)

    // Every position on the middle floor, read back in order.
    const floorTwo = createdUnits
      .filter((unit) => unit.floor === 2)
      .sort((a, b) => a.name.localeCompare(b.name))

    expect(floorTwo.map((unit) => unit.name)).toEqual([
      '201', '202', '203', '204', '205', '206', '207', '208'
    ])
    expect(floorTwo.map((unit) => unit.bedrooms)).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
    expect(floorTwo.map((unit) => unit.sizeSqm)).toEqual([
      '48.00', '50.00', '82.00', '82.00', '124.00', '130.00', '188.00', '196.00'
    ])
    expect(floorTwo.map((unit) => unit.priceMinor)).toEqual([
      520000000n, 540000000n, 810000000n, 810000000n,
      1190000000n, 1240000000n, 1675000000n, 1730000000n
    ])
  })

  it('refuses a row count that disagrees with the units on a floor', async () => {
    // The no-JavaScript case: the rows on the page and the number in the box
    // have drifted apart. Refused before anything is written, not truncated.
    await expect(
      createProject(admin, { ...base, floors: 4, unitsPerFloor: 8, unitTypes: KHALEEL_POSITIONS })
    ).rejects.toBeInstanceOf(ServiceError)

    await expect(
      createProject(admin, {
        ...base,
        floors: 4,
        unitsPerFloor: 2,
        unitTypes: KHALEEL_POSITIONS
      })
    ).rejects.toThrow(/2 unit positions/)

    expect($transaction).not.toHaveBeenCalled()
  })

  it('turns an unparseable price into a validation error naming its position', async () => {
    const rows = KHALEEL_POSITIONS.map((row) => ({ ...row }))
    rows[2].price = '18000000.50' // KES has two decimals, so this one is fine…

    await expect(
      createProject(admin, { ...base, floors: 2, unitsPerFloor: 4, unitTypes: rows })
    ).resolves.toMatchObject({ unitCount: 8 })

    // …and impossible in a zero-decimal currency.
    await expect(
      createProject(admin, {
        ...base,
        currency: 'RWF',
        floors: 2,
        unitsPerFloor: 4,
        unitTypes: rows
      })
    ).rejects.toThrow(/Unit position 3/)
  })

  it('stays ADMIN-only', async () => {
    await expect(
      createProject(
        { ...admin, role: 'AGENT' },
        { ...base, floors: 1, unitsPerFloor: 4, unitTypes: KHALEEL_POSITIONS }
      )
    ).rejects.toThrow()
    expect($transaction).not.toHaveBeenCalled()
  })
})

describe('createProject is audited', () => {
  it('records who created it, and how much inventory it put on the books', async () => {
    await createProject(admin, {
      ...base,
      floors: 16,
      unitsPerFloor: 4,
      unitTypes: KHALEEL_POSITIONS
    })

    const [entry] = audit.of('project.created')
    expect(entry).toBeDefined()
    expect(entry.actorUserId).toBe('user_1')
    expect(entry.actorRole).toBe('ADMIN')
    expect(entry.entityType).toBe('Project')
    expect(entry.entityId).toBe('project_1')
    expect(entry.entityLabel).toBe('Khaleel Suites')
    expect(entry.context).toMatchObject({ unitCount: 64, currency: 'KES' })
  })

  it('records nothing when the project was refused', async () => {
    const failure = await createProject(admin, {
      ...base,
      floors: 2,
      unitsPerFloor: 4,
      // Position 3's price is not a number, so the whole thing is refused
      // before the transaction opens.
      unitTypes: [
        ...KHALEEL_POSITIONS.slice(0, 2),
        { ...KHALEEL_POSITIONS[2], price: 'not-a-number' },
        KHALEEL_POSITIONS[3]
      ]
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ServiceError)
    expect(audit.entries).toHaveLength(0)
  })
})
