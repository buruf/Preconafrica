import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { applyAllocations, recomputeEntries } from '@/server/services/allocations'
import type { Allocation } from '@/domain/allocation'

/**
 * A fake `Prisma.TransactionClient`.
 *
 * These two functions do no I/O of their own — they issue statements and do
 * arithmetic on what comes back — so an in-memory stand-in that records every
 * call exercises the real money rules without a database. That is what lets
 * these tests assert the thing a live database check cannot: *how many*
 * statements were issued, which is the regression guard against the
 * per-allocation N+1 this module was written to remove.
 */
interface StoredAllocation {
  scheduleEntryId: string
  amountMinor: bigint
  /** Whether the owning Payment has been voided. */
  voided?: boolean
}

interface RecordedCall {
  op: string
  args: unknown
}

function fakeTx(existing: StoredAllocation[] = []) {
  const calls: RecordedCall[] = []
  const store: StoredAllocation[] = existing.map((row) => ({ ...row }))

  const tx = {
    paymentAllocation: {
      createMany: async (args: { data: Array<{ scheduleEntryId: string; amountMinor: bigint }> }) => {
        calls.push({ op: 'paymentAllocation.createMany', args })
        for (const row of args.data) {
          store.push({ scheduleEntryId: row.scheduleEntryId, amountMinor: row.amountMinor })
        }
        return { count: args.data.length }
      },
      findMany: async (args: {
        where: { scheduleEntryId: { in: string[] }; payment?: { voidedAt: null } }
      }) => {
        calls.push({ op: 'paymentAllocation.findMany', args })
        const wanted = new Set(args.where.scheduleEntryId.in)
        // Mirrors the real where-clause: the voided filter is only applied if
        // the caller actually asked for it. Drop `payment: { voidedAt: null }`
        // from the implementation and voided money starts counting again.
        const excludeVoided = args.where.payment?.voidedAt === null
        return store
          .filter((row) => wanted.has(row.scheduleEntryId))
          .filter((row) => !(excludeVoided && row.voided))
          .map((row) => ({ scheduleEntryId: row.scheduleEntryId, amountMinor: row.amountMinor }))
      }
    },
    scheduleEntry: {
      updateMany: async (args: unknown) => {
        calls.push({ op: 'scheduleEntry.updateMany', args })
        return { count: 0 }
      }
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values)
      calls.push({ op: '$executeRaw', args: { text: sql.text, values: sql.values } })
      return 0
    }
  }

  return { tx: tx as unknown as Prisma.TransactionClient, calls, store }
}

/** The `(id, amount)` pairs the bulk UPDATE actually wrote. */
function writtenTotals(calls: RecordedCall[]): Record<string, string> {
  const raw = calls.filter((c) => c.op === '$executeRaw')
  expect(raw, 'expected exactly one bulk total update').toHaveLength(1)
  const values = (raw[0].args as { values: unknown[] }).values
  const totals: Record<string, string> = {}
  for (let i = 0; i < values.length; i += 2) {
    totals[String(values[i])] = String(values[i + 1])
  }
  return totals
}

function opCounts(calls: RecordedCall[]): Record<string, number> {
  return calls.reduce<Record<string, number>>((acc, call) => {
    acc[call.op] = (acc[call.op] ?? 0) + 1
    return acc
  }, {})
}

const RECEIVED_AT = new Date('2026-08-09T00:00:00.000Z')

describe('recomputeEntries', () => {
  it('sums the surviving allocations rather than incrementing the prior value', async () => {
    // The entry already holds 400 from an earlier payment; this run adds 100.
    // Correct is 500 (the sum). An increment-based implementation that added
    // 100 to a cached 500 would write 600 — and no amount of re-running would
    // ever bring it back.
    const { tx, calls } = fakeTx([
      { scheduleEntryId: 'e1', amountMinor: 400n },
      { scheduleEntryId: 'e1', amountMinor: 100n }
    ])

    await recomputeEntries(tx, [{ id: 'e1', amountDueMinor: 1000n }], RECEIVED_AT)

    expect(writtenTotals(calls)).toEqual({ e1: '500' })
    // Nothing may reach the database as a relative change.
    expect(JSON.stringify(calls)).not.toContain('increment')
    expect(JSON.stringify(calls)).not.toContain('decrement')
  })

  it('writes zero for an entry whose every allocation has been withdrawn', async () => {
    const { tx, calls } = fakeTx([{ scheduleEntryId: 'e1', amountMinor: 700n, voided: true }])

    await recomputeEntries(tx, [{ id: 'e1', amountDueMinor: 1000n }], RECEIVED_AT)

    expect(writtenTotals(calls)).toEqual({ e1: '0' })
  })

  it('excludes voided payments from the total', async () => {
    const { tx, calls } = fakeTx([
      { scheduleEntryId: 'e1', amountMinor: 300n },
      { scheduleEntryId: 'e1', amountMinor: 900n, voided: true },
      { scheduleEntryId: 'e1', amountMinor: 200n }
    ])

    const settled = await recomputeEntries(tx, [{ id: 'e1', amountDueMinor: 1000n }], RECEIVED_AT)

    expect(writtenTotals(calls)).toEqual({ e1: '500' })
    expect(settled).toEqual([])

    const read = calls.find((c) => c.op === 'paymentAllocation.findMany')
    expect((read?.args as { where: { payment: { voidedAt: null } } }).where.payment).toEqual({
      voidedAt: null
    })
  })

  it('stamps paidAt on entries that are now fully settled', async () => {
    const { tx, calls } = fakeTx([
      { scheduleEntryId: 'e1', amountMinor: 1000n },
      { scheduleEntryId: 'e2', amountMinor: 250n }
    ])

    const settled = await recomputeEntries(
      tx,
      [
        { id: 'e1', amountDueMinor: 1000n },
        { id: 'e2', amountDueMinor: 1000n }
      ],
      RECEIVED_AT
    )

    expect(settled).toEqual(['e1'])

    const updates = calls.filter((c) => c.op === 'scheduleEntry.updateMany').map((c) => c.args)
    expect(updates).toEqual([
      { where: { id: { in: ['e1'] } }, data: { paidAt: RECEIVED_AT } },
      { where: { id: { in: ['e2'] } }, data: { paidAt: null } }
    ])
  })

  it('counts an overpaid entry as settled', async () => {
    const { tx, calls } = fakeTx([{ scheduleEntryId: 'e1', amountMinor: 1500n }])

    const settled = await recomputeEntries(tx, [{ id: 'e1', amountDueMinor: 1000n }], RECEIVED_AT)

    expect(settled).toEqual(['e1'])
    expect(writtenTotals(calls)).toEqual({ e1: '1500' })
  })

  it('leaves paidAt untouched on entries still settled after a void', async () => {
    // `undefined` means "leave paidAt unchanged" — an entry another payment
    // already settled keeps its original settlement date rather than being
    // restamped by a void it was not part of settling. Only the entry that
    // drops below fully-paid is cleared.
    const { tx, calls } = fakeTx([
      { scheduleEntryId: 'e1', amountMinor: 1000n },
      { scheduleEntryId: 'e2', amountMinor: 100n }
    ])

    const settled = await recomputeEntries(
      tx,
      [
        { id: 'e1', amountDueMinor: 1000n },
        { id: 'e2', amountDueMinor: 1000n }
      ],
      undefined
    )

    expect(settled).toEqual(['e1'])

    const updates = calls.filter((c) => c.op === 'scheduleEntry.updateMany').map((c) => c.args)
    // Exactly one write: the cleared entry. e1 is never named, so its paidAt
    // cannot be disturbed.
    expect(updates).toEqual([{ where: { id: { in: ['e2'] } }, data: { paidAt: null } }])
    expect(JSON.stringify(updates)).not.toContain('e1')
  })

  it('issues no statements at all for an empty entry list', async () => {
    const { tx, calls } = fakeTx()
    expect(await recomputeEntries(tx, [], RECEIVED_AT)).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('applyAllocations', () => {
  const entries = [
    { id: 'e1', amountDueMinor: 1000n },
    { id: 'e2', amountDueMinor: 1000n },
    { id: 'e3', amountDueMinor: 1000n }
  ]

  it('writes one allocation row per allocation and recomputes each entry', async () => {
    const { tx, calls } = fakeTx()
    const allocations: Allocation[] = [
      { entryId: 'e1', amountMinor: 1000n },
      { entryId: 'e2', amountMinor: 1000n },
      { entryId: 'e3', amountMinor: 400n }
    ]

    const settled = await applyAllocations(tx, 'pay_1', allocations, RECEIVED_AT, entries)

    const created = calls.find((c) => c.op === 'paymentAllocation.createMany')
    expect((created?.args as { data: unknown[] }).data).toEqual([
      { paymentId: 'pay_1', scheduleEntryId: 'e1', amountMinor: 1000n },
      { paymentId: 'pay_1', scheduleEntryId: 'e2', amountMinor: 1000n },
      { paymentId: 'pay_1', scheduleEntryId: 'e3', amountMinor: 400n }
    ])

    // Three entries, three correct totals, one statement.
    expect(writtenTotals(calls)).toEqual({ e1: '1000', e2: '1000', e3: '400' })
    expect(settled).toEqual(['e1', 'e2'])
  })

  it('adds to what an entry already holds instead of replacing it', async () => {
    const { tx, calls } = fakeTx([{ scheduleEntryId: 'e1', amountMinor: 600n }])

    await applyAllocations(tx, 'pay_2', [{ entryId: 'e1', amountMinor: 400n }], RECEIVED_AT, entries)

    expect(writtenTotals(calls)).toEqual({ e1: '1000' })
  })

  it('issues the same number of statements for 1 allocation as for 20', async () => {
    // The regression guard. The previous implementation did create +
    // findMany + findUniqueOrThrow + update *per allocation*: 4 statements
    // for one, 80 for twenty. Paying off a 36-month schedule in one payment
    // meant ~144 sequential round trips, which is what forced the 30s
    // transaction-timeout override that Vercel's own function timeout would
    // have killed long before it ever expired.
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      amountDueMinor: 1000n
    }))

    const one = fakeTx()
    await applyAllocations(one.tx, 'p', [{ entryId: 'm0', amountMinor: 1000n }], RECEIVED_AT, many)

    const twenty = fakeTx()
    await applyAllocations(
      twenty.tx,
      'p',
      many.map((entry) => ({ entryId: entry.id, amountMinor: 1000n })),
      RECEIVED_AT,
      many
    )

    expect(one.calls).toHaveLength(4)
    expect(twenty.calls).toHaveLength(one.calls.length)
    expect(opCounts(twenty.calls)).toEqual(opCounts(one.calls))
    expect(opCounts(twenty.calls)).toEqual({
      'paymentAllocation.createMany': 1,
      'paymentAllocation.findMany': 1,
      $executeRaw: 1,
      'scheduleEntry.updateMany': 1
    })

    // ...and all twenty totals still landed.
    expect(Object.keys(writtenTotals(twenty.calls))).toHaveLength(20)
  })

  it('never exceeds five statements even when the cascade is partial', async () => {
    // Partial tail => both paidAt buckets are written, the worst case.
    const many = Array.from({ length: 36 }, (_, i) => ({ id: `m${i}`, amountDueMinor: 1000n }))
    const { tx, calls } = fakeTx()

    await applyAllocations(
      tx,
      'p',
      many.map((entry, i) => ({ entryId: entry.id, amountMinor: i === 35 ? 10n : 1000n })),
      RECEIVED_AT,
      many
    )

    expect(calls).toHaveLength(5)
    expect(opCounts(calls)['scheduleEntry.updateMany']).toBe(2)
  })

  it('issues no statements for a payment that allocated nowhere', async () => {
    // No caller can produce this any more — a payment now always carries
    // exactly one allocation — but the guard stays: it is what kept the old
    // cascade's pure-overpayment case from issuing a pointless UPDATE, and a
    // helper that quietly wrote nothing-shaped SQL would be worse than one
    // that returns early.
    const { tx, calls } = fakeTx()
    expect(await applyAllocations(tx, 'pay_3', [], RECEIVED_AT, entries)).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses to recompute an entry the caller never loaded', async () => {
    const { tx } = fakeTx()
    await expect(
      applyAllocations(tx, 'pay_4', [{ entryId: 'ghost', amountMinor: 1n }], RECEIVED_AT, entries)
    ).rejects.toThrow(/no amountDueMinor supplied/)
  })
})
