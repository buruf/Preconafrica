import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceError } from '@/server/services/errors'
import type { SessionActor } from '@/server/session'
import { auditRecorder } from './audit-fake'

/**
 * "Who changed that unit's price" — end to end.
 *
 * This is one of the three questions the owner named, and the one the old
 * schema had no trace of at all: a `Unit` row carries only its current price,
 * so before this the previous figure was simply gone. The assertions below are
 * about the whole path, not the diff helper: an ADMIN edits a unit, and an
 * entry appears, inside the same transaction, with the right actor and the
 * exact before and after.
 */
vi.mock('@/server/db', () => ({
  prisma: {
    unit: { findFirst: vi.fn() },
    $transaction: vi.fn()
  }
}))

// The blob sweep runs after the update and talks to Vercel Blob; it has nothing
// to do with the audit trail and must not reach the network from a test.
vi.mock('@/server/media/blob', () => ({ deleteReplacedBlobs: vi.fn(async () => undefined) }))

const { prisma } = await import('@/server/db')
const { updateUnit } = await import('@/server/services/units')

const findFirst = prisma.unit.findFirst as unknown as ReturnType<typeof vi.fn>
const $transaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>

const admin: SessionActor = {
  userId: 'user_1',
  orgId: 'org_1',
  role: 'ADMIN',
  buyerId: null,
  fullName: 'Ada Okafor',
  email: 'admin@sunrise.test'
}

/** 4C as it stands: 145,000,000.00 NGN, three beds. */
const EXISTING = {
  id: 'unit_4c',
  projectId: 'project_1',
  name: '4C',
  floor: 4,
  bedrooms: 3,
  sizeSqm: { toString: () => '210.00' },
  priceMinor: 14_500_000_000n,
  status: 'AVAILABLE' as const,
  layoutImageUrl: null,
  renderImageUrls: [] as string[],
  project: { currency: 'NGN' }
}

let audit = auditRecorder()
let calls: string[] = []

/** Applies the patch to the stored row, exactly as `unit.update` would. */
function fakeTransaction() {
  $transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      unit: {
        update: async ({ data }: { data: Record<string, unknown> }) => {
          calls.push('unit.update')
          const merged: Record<string, unknown> = { ...EXISTING, ...data }
          // Prisma hands back a Decimal for sizeSqm; the service only ever
          // calls toString() on it, so a string with one is a faithful stand-in.
          if (typeof merged.sizeSqm === 'string') {
            const raw = merged.sizeSqm
            merged.sizeSqm = { toString: () => raw }
          }
          return merged
        }
      },
      auditEntry: audit.auditEntry
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  audit = auditRecorder((action) => calls.push(`audit:${action}`))
  calls = []
  findFirst.mockResolvedValue(EXISTING)
  fakeTransaction()
})

describe('changing a unit price is recorded', () => {
  it('records who, what, and the exact before and after', async () => {
    await updateUnit(admin, 'unit_4c', { price: '149000000' })

    const [entry] = audit.of('unit.updated')
    expect(entry).toBeDefined()
    expect(entry.actorUserId).toBe('user_1')
    expect(entry.actorName).toBe('Ada Okafor')
    expect(entry.actorRole).toBe('ADMIN')
    expect(entry.orgId).toBe('org_1')
    expect(entry.entityType).toBe('Unit')
    expect(entry.entityId).toBe('unit_4c')
    expect(entry.entityLabel).toBe('4C')

    // Exactly one field, with both sides, as exact minor units.
    expect(entry.changes).toEqual([
      {
        field: 'priceMinor',
        from: { kind: 'money', minor: '14500000000', currency: 'NGN' },
        to: { kind: 'money', minor: '14900000000', currency: 'NGN' }
      }
    ])
  })

  it('records nothing about the eleven columns that did not move', async () => {
    await updateUnit(admin, 'unit_4c', { price: '149000000' })

    const fields = audit.of('unit.updated')[0].changes.map((change) => change.field)
    expect(fields).toEqual(['priceMinor'])
    expect(fields).not.toContain('bedrooms')
    expect(fields).not.toContain('sizeSqm')
    expect(fields).not.toContain('name')
    expect(fields).not.toContain('layoutImageUrl')
  })

  it('writes the entry inside the same transaction as the update', async () => {
    await updateUnit(admin, 'unit_4c', { price: '149000000' })

    // Both are in the list at all only because both went through the
    // transaction client. If the audit call moved outside `$transaction`, the
    // marker would be missing entirely.
    expect(calls).toEqual(['unit.update', 'audit:unit.updated'])
  })

  it('records a rename with the old name, and labels the entry with the new one', async () => {
    await updateUnit(admin, 'unit_4c', { name: '4C-PH' })

    const [entry] = audit.of('unit.updated')
    // The label is what the unit became; the change preserves what it was. An
    // entry written later still reads "unit 4C-PH", and this one still shows
    // where that name came from.
    expect(entry.entityLabel).toBe('4C-PH')
    expect(entry.changes).toEqual([
      { field: 'name', from: { kind: 'text', value: '4C' }, to: { kind: 'text', value: '4C-PH' } }
    ])
  })

  it('records several fields in one entry when one edit moved several', async () => {
    await updateUnit(admin, 'unit_4c', { price: '149000000', bedrooms: 4, sizeSqm: '215.00' })

    const [entry] = audit.of('unit.updated')
    expect(entry.changes.map((change) => change.field)).toEqual([
      'priceMinor',
      'bedrooms',
      'sizeSqm'
    ])
    // One person, one moment, one entry — not three rows to read separately.
    expect(audit.entries).toHaveLength(1)
  })

  it('records nothing when the form was saved unchanged', async () => {
    await updateUnit(admin, 'unit_4c', { price: '145000000', bedrooms: 3 })

    // "Somebody pressed Save" is not history, and this is the largest table in
    // the database.
    expect(audit.entries).toHaveLength(0)
  })

  it('records nothing when the edit was refused', async () => {
    const failure = await updateUnit(admin, 'unit_4c', { price: '149000000.999' }).catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(ServiceError)
    expect(audit.entries).toHaveLength(0)
    expect($transaction).not.toHaveBeenCalled()
  })

  it('refuses an agent, and records nothing', async () => {
    const failure = await updateUnit({ ...admin, role: 'AGENT' }, 'unit_4c', {
      price: '149000000'
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ServiceError)
    expect(audit.entries).toHaveLength(0)
  })
})
