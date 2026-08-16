import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceError } from '@/server/services/errors'
import type { SessionActor } from '@/server/session'
import { auditRecorder } from './audit-fake'

/**
 * Voiding, under the targeted allocation rule.
 *
 * The rule's second consequence — after "overpayment cannot happen" — is that
 * a void has nothing to re-cascade. A payment touches one entry, so withdrawing
 * it can only move that entry; no later entry's balance was ever derived from
 * this payment flowing past. These tests pin that down from the outside: what
 * the void actually wrote, and what it left alone.
 *
 * The invariant underneath is unchanged and must never be weakened: every
 * entry's `amountPaidMinor` is *recomputed* from the allocation rows that
 * survive, never decremented by the amount being withdrawn. That is what makes
 * the cached total agree with the audit trail after a void, a retry, or a
 * concurrent write — and it is why old multi-entry payments from the cascade
 * era still void correctly with no special handling.
 */
vi.mock('@/server/db', () => ({
  prisma: {
    payment: { findFirst: vi.fn() },
    $transaction: vi.fn()
  }
}))

const { prisma } = await import('@/server/db')
const { voidPayment } = await import('@/server/services/payments')

const findFirst = prisma.payment.findFirst as unknown as ReturnType<typeof vi.fn>
const $transaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>

const admin: SessionActor = {
  userId: 'user_1',
  orgId: 'org_1',
  role: 'ADMIN',
  buyerId: null,
  fullName: 'Ada Okafor',
  email: 'admin@sunrise.test'
}

const agent: SessionActor = { ...admin, role: 'AGENT', email: 'agent@sunrise.test' }

interface StoredAllocation {
  paymentId: string
  scheduleEntryId: string
  amountMinor: bigint
}

/** e1 and e2 each owe 300.00; the schedule is otherwise irrelevant here. */
const DUE: Record<string, bigint> = { e1: 30000n, e2: 30000n }

function fakeTx(allocations: StoredAllocation[]) {
  const calls: string[] = []
  // Audit writes join the same ordered call list, so their placement inside the
  // transaction is assertable rather than assumed.
  const audit = auditRecorder((action) => calls.push(`audit:${action}`))
  const store = allocations.map((row) => ({ ...row }))
  /** entryId -> the total the bulk UPDATE actually wrote. */
  const written: Record<string, string> = {}

  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push('lockSale')
      Prisma.sql(strings, ...values)
      return []
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push('$executeRaw')
      const sql = Prisma.sql(strings, ...values)
      for (let i = 0; i < sql.values.length; i += 2) {
        written[String(sql.values[i])] = String(sql.values[i + 1])
      }
      return 0
    },
    sale: {
      findUniqueOrThrow: async () => {
        calls.push('sale.findUniqueOrThrow')
        return { status: 'ACTIVE' }
      },
      update: async (args: { data: { status: string } }) => {
        calls.push(`sale.update:${args.data.status}`)
        return {}
      }
    },
    payment: {
      updateMany: async () => {
        calls.push('payment.updateMany')
        return { count: 1 }
      }
    },
    paymentAllocation: {
      deleteMany: async (args: { where: { paymentId: string } }) => {
        calls.push('paymentAllocation.deleteMany')
        const before = store.length
        for (let i = store.length - 1; i >= 0; i -= 1) {
          if (store[i].paymentId === args.where.paymentId) store.splice(i, 1)
        }
        return { count: before - store.length }
      },
      createMany: async () => {
        // Nothing in a void may ever write an allocation. If this is reached,
        // something has grown a re-cascade.
        calls.push('paymentAllocation.createMany')
        return { count: 0 }
      },
      findMany: async (args: { where: { scheduleEntryId: { in: string[] } } }) => {
        calls.push('paymentAllocation.findMany')
        const wanted = new Set(args.where.scheduleEntryId.in)
        return store
          .filter((row) => wanted.has(row.scheduleEntryId))
          .map((row) => ({ scheduleEntryId: row.scheduleEntryId, amountMinor: row.amountMinor }))
      }
    },
    scheduleEntry: {
      findMany: async (args: { where: { id?: { in: string[] }; saleId?: string } }) => {
        calls.push('scheduleEntry.findMany')
        // The recompute's read of due amounts...
        if (args.where.id) {
          return args.where.id.in.map((id) => ({ id, amountDueMinor: DUE[id] }))
        }
        // ...and syncSaleStatus's read of the schedule as it now stands.
        return Object.entries(DUE).map(([id, amountDueMinor]) => ({
          amountDueMinor,
          amountPaidMinor: store
            .filter((row) => row.scheduleEntryId === id)
            .reduce((sum, row) => sum + row.amountMinor, 0n)
        }))
      },
      updateMany: async () => {
        calls.push('scheduleEntry.updateMany')
        return { count: 0 }
      }
    },
    auditEntry: audit.auditEntry
  }

  return { tx: tx as unknown as Prisma.TransactionClient, calls, store, written, audit }
}

/**
 * The reconciliation invariant, asserted against the rows that survive: for
 * every entry the void recomputed, the total written equals the sum of the
 * allocations still standing against it.
 */
function expectReconciles(store: StoredAllocation[], written: Record<string, string>) {
  for (const [entryId, total] of Object.entries(written)) {
    const surviving = store
      .filter((row) => row.scheduleEntryId === entryId)
      .reduce((sum, row) => sum + row.amountMinor, 0n)
    expect(BigInt(total), `entry ${entryId} must equal the sum of its surviving allocations`).toBe(
      surviving
    )
  }
}

describe('voidPayment', () => {
  beforeEach(() => vi.clearAllMocks())

  it('moves only the entry the voided payment was recorded against', async () => {
    // Two payments on one sale: e1 settled by payment_a, e2 settled by
    // payment_b. Voiding payment_b must take e2 back to zero and leave e1
    // exactly where it was.
    const { tx, calls, store, written } = fakeTx([
      { paymentId: 'payment_a', scheduleEntryId: 'e1', amountMinor: 30000n },
      { paymentId: 'payment_b', scheduleEntryId: 'e2', amountMinor: 30000n }
    ])
    findFirst.mockResolvedValue({
      id: 'payment_b',
      saleId: 'sale_1',
      amountMinor: 30000n,
      voidedAt: null,
      sale: { currency: 'NGN', unit: { id: 'unit_4c', name: '4C', projectId: 'project_1' } },
      allocations: [{ scheduleEntryId: 'e2', scheduleEntry: { sequence: 2 } }]
    })
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    await voidPayment(admin, 'payment_b', 'recorded twice')

    expect(written).toEqual({ e2: '0' })
    // e1 is never named in a write at all — not recomputed to the same value,
    // simply not touched.
    expect(written).not.toHaveProperty('e1')
    expectReconciles(store, written)
    // payment_a's allocation survives, so e1's balance is undisturbed.
    expect(store).toEqual([
      { paymentId: 'payment_a', scheduleEntryId: 'e1', amountMinor: 30000n }
    ])
    // Nothing was re-cascaded. A void writes no allocations, ever.
    expect(calls).not.toContain('paymentAllocation.createMany')
  })

  it('recomputes rather than decrements, so a partial entry lands on the surviving total', async () => {
    // e2 holds two payments. Voiding one must leave the other's amount — the
    // sum of what survives — not "what was there minus what was withdrawn",
    // which would agree only until something else raced it.
    const { tx, store, written } = fakeTx([
      { paymentId: 'payment_a', scheduleEntryId: 'e2', amountMinor: 12000n },
      { paymentId: 'payment_b', scheduleEntryId: 'e2', amountMinor: 8000n }
    ])
    findFirst.mockResolvedValue({
      id: 'payment_b',
      saleId: 'sale_1',
      amountMinor: 8000n,
      voidedAt: null,
      sale: { currency: 'NGN', unit: { id: 'unit_4c', name: '4C', projectId: 'project_1' } },
      allocations: [{ scheduleEntryId: 'e2', scheduleEntry: { sequence: 2 } }]
    })
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    await voidPayment(admin, 'payment_b', 'wrong reference')

    expect(written).toEqual({ e2: '12000' })
    expectReconciles(store, written)
  })

  it('withdraws an old multi-entry payment from every entry it reached', async () => {
    // History from the cascade era: one payment spread across two entries.
    // Those rows are valid and are not migrated, so a void still has to undo
    // all of it — and the recompute does that with no special handling,
    // because it works from the surviving rows rather than from the rule that
    // created them.
    const { tx, calls, store, written } = fakeTx([
      { paymentId: 'legacy', scheduleEntryId: 'e1', amountMinor: 30000n },
      { paymentId: 'legacy', scheduleEntryId: 'e2', amountMinor: 5000n },
      { paymentId: 'payment_a', scheduleEntryId: 'e2', amountMinor: 1000n }
    ])
    findFirst.mockResolvedValue({
      id: 'legacy',
      saleId: 'sale_1',
      amountMinor: 35000n,
      voidedAt: null,
      sale: { currency: 'NGN', unit: { id: 'unit_4c', name: '4C', projectId: 'project_1' } },
      allocations: [
        { scheduleEntryId: 'e2', scheduleEntry: { sequence: 2 } },
        { scheduleEntryId: 'e1', scheduleEntry: { sequence: 1 } }
      ]
    })
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    const result = await voidPayment(admin, 'legacy', 'duplicate deposit')

    expect(written).toEqual({ e1: '0', e2: '1000' })
    expectReconciles(store, written)
    expect(calls).not.toContain('paymentAllocation.createMany')
    // Sorted, so the confirmation reads in schedule order rather than in
    // whatever order the rows came back.
    expect(result.entrySequences).toEqual([1, 2])
    expect(result.amountMinor).toBe(35000n)
    expect(result.currency).toBe('NGN')
  })

  it('takes the sale lock before it withdraws anything', async () => {
    const { tx, calls } = fakeTx([
      { paymentId: 'payment_b', scheduleEntryId: 'e2', amountMinor: 30000n }
    ])
    findFirst.mockResolvedValue({
      id: 'payment_b',
      saleId: 'sale_1',
      amountMinor: 30000n,
      voidedAt: null,
      sale: { currency: 'NGN', unit: { id: 'unit_4c', name: '4C', projectId: 'project_1' } },
      allocations: [{ scheduleEntryId: 'e2', scheduleEntry: { sequence: 2 } }]
    })
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    await voidPayment(admin, 'payment_b', 'recorded twice')

    expect(calls[0]).toBe('lockSale')
    expect(calls.indexOf('lockSale')).toBeLessThan(calls.indexOf('payment.updateMany'))
    expect(calls.indexOf('lockSale')).toBeLessThan(calls.indexOf('paymentAllocation.deleteMany'))
  })

  it('is refused to an agent, whatever the payment', async () => {
    // Voiding rewrites balances, so the guard is ADMIN and stays ADMIN.
    await expect(voidPayment(agent, 'payment_b', 'nope')).rejects.toThrow()
    expect(findFirst).not.toHaveBeenCalled()
    expect($transaction).not.toHaveBeenCalled()
  })

  it('requires a reason', async () => {
    const failure = await voidPayment(admin, 'payment_b', '   ').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ServiceError)
    expect($transaction).not.toHaveBeenCalled()
  })

  it('refuses to void a payment twice', async () => {
    findFirst.mockResolvedValue({
      id: 'payment_b',
      saleId: 'sale_1',
      amountMinor: 30000n,
      voidedAt: new Date('2026-08-10T00:00:00.000Z'),
      sale: { currency: 'NGN', unit: { id: 'unit_4c', name: '4C', projectId: 'project_1' } },
      allocations: []
    })

    const failure = await voidPayment(admin, 'payment_b', 'again').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ServiceError)
    expect((failure as ServiceError).code).toBe('CONFLICT')
    expect($transaction).not.toHaveBeenCalled()
  })

  it('treats a payment outside the actor organisation as NOT_FOUND', async () => {
    findFirst.mockResolvedValue(null)

    const failure = await voidPayment(admin, 'someone_elses', 'x').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ServiceError)
    expect((failure as ServiceError).code).toBe('NOT_FOUND')
    expect($transaction).not.toHaveBeenCalled()
  })
})

/**
 * The question the owner asked for by name: who voided that payment, and why.
 *
 * The reason is the part of a void that cannot be reconstructed from the rows
 * afterwards — the allocations are simply gone — so an entry that carried the
 * figure but not the reason would answer half of it.
 */
describe('voidPayment writes the audit trail', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records the actor, the figure and the reason, inside the transaction', async () => {
    const { tx, calls, audit } = fakeTx([
      { paymentId: 'payment_b', scheduleEntryId: 'e2', amountMinor: 18333333n }
    ])
    findFirst.mockResolvedValue({
      id: 'payment_b',
      saleId: 'sale_1',
      amountMinor: 18333333n,
      voidedAt: null,
      sale: { currency: 'KES', unit: { id: 'unit_4c', name: '4C', projectId: 'project_1' } },
      allocations: [{ scheduleEntryId: 'e2', scheduleEntry: { sequence: 2 } }]
    })
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    await voidPayment(admin, 'payment_b', '  duplicate entry  ')

    const [entry] = audit.of('payment.voided')
    expect(entry).toBeDefined()
    expect(entry.actorUserId).toBe('user_1')
    expect(entry.actorName).toBe('Ada Okafor')
    expect(entry.actorRole).toBe('ADMIN')
    expect(entry.entityType).toBe('Payment')
    expect(entry.entityId).toBe('payment_b')
    expect(entry.entityLabel).toBe('4C')
    // The same trimmed reason the Payment row stores, so what the log quotes
    // and what the record holds cannot disagree.
    expect(entry.context).toMatchObject({
      saleId: 'sale_1',
      unitName: '4C',
      currency: 'KES',
      amountMinor: '18333333',
      reason: 'duplicate entry'
    })
    // Written through the transaction client, after the void itself.
    expect(calls).toContain('audit:payment.voided')
    expect(calls.indexOf('payment.updateMany')).toBeLessThan(
      calls.indexOf('audit:payment.voided')
    )
  })

  it('writes no entry at all when the void is refused', async () => {
    const { tx, audit } = fakeTx([])
    findFirst.mockResolvedValue({
      id: 'payment_b',
      saleId: 'sale_1',
      amountMinor: 30000n,
      voidedAt: new Date('2026-08-01T00:00:00Z'),
      sale: { currency: 'NGN', unit: { id: 'unit_4c', name: '4C', projectId: 'project_1' } },
      allocations: []
    })
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    await voidPayment(admin, 'payment_b', 'duplicate entry').catch(() => undefined)

    // An attempt that changed nothing is not history. The log records what
    // happened, not what somebody tried.
    expect(audit.entries).toHaveLength(0)
  })

  it('refuses an agent without recording anything', async () => {
    const failure = await voidPayment(agent, 'payment_b', 'duplicate entry').catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(ServiceError)
    expect($transaction).not.toHaveBeenCalled()
  })
})
