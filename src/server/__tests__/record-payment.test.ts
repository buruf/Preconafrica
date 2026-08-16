import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceError } from '@/server/services/errors'
import { formatMinor } from '@/domain/currency'
import type { SessionActor } from '@/server/session'

/**
 * recordPayment's money arithmetic is already covered by the pure allocation
 * and allocations-helper tests. What was untested is its *orchestration* — the
 * order things happen in, and what happens inside the transaction rather than
 * after it. Both are correctness properties no amount of arithmetic testing
 * reaches, and both are exactly the kind of thing a well-meaning refactor
 * quietly breaks:
 *
 *   - the row lock has to be taken BEFORE the schedule is read, because the
 *     stale read is precisely what a second concurrent writer would allocate
 *     against;
 *   - the receipt has to be issued with the transaction's client, so a payment
 *     can never commit without one;
 *   - the chosen entry has to be resolved within the sale, so an id from
 *     someone else's contract is NOT_FOUND rather than paid.
 *
 * A fake `tx` that records every call is what makes those assertable at all,
 * following the pattern in allocations.test.ts.
 */
vi.mock('@/server/db', () => ({
  prisma: {
    sale: { findFirst: vi.fn() },
    $transaction: vi.fn()
  }
}))

const { prisma } = await import('@/server/db')
const { recordPayment } = await import('@/server/services/payments')

const findFirst = prisma.sale.findFirst as unknown as ReturnType<typeof vi.fn>
const $transaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>

const actor: SessionActor = {
  userId: 'user_1',
  orgId: 'org_1',
  role: 'AGENT',
  buyerId: null,
  fullName: 'Tunde Bakare',
  email: 'agent@sunrise.test'
}

/** 300.00 NGN against installment 2 — an exact settlement of that one entry. */
const input = {
  saleId: 'sale_1',
  scheduleEntryId: 'e2',
  amount: '300',
  receivedAt: '2026-08-09',
  method: 'BANK_TRANSFER' as const,
  reference: 'GTB/2026/08/0021',
  note: undefined
}

const ENTRIES = [
  { id: 'e1', sequence: 1, amountDueMinor: 30000n, amountPaidMinor: 0n },
  { id: 'e2', sequence: 2, amountDueMinor: 30000n, amountPaidMinor: 0n }
]

/**
 * An in-memory transaction client that records the operation names in the
 * order they were issued. `status` is what the locked re-read reports,
 * `entry` is what the targeted lookup finds (null for a forged id), and
 * `entriesAfterRecompute` (when given) is what the post-allocation read in
 * syncSaleStatus sees, which is how the COMPLETED transition is exercised
 * without re-simulating the recompute.
 */
function fakeTx(options: {
  status?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
  entry?: (typeof ENTRIES)[number] | null
  entriesAfterRecompute?: Array<{ amountDueMinor: bigint; amountPaidMinor: bigint }>
} = {}) {
  const calls: string[] = []
  const status = options.status ?? 'ACTIVE'
  const entry = options.entry === undefined ? ENTRIES[1] : options.entry
  const allocationRows: Array<{ scheduleEntryId: string; amountMinor: bigint }> = []

  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // Only lockSale issues raw SQL against Sale — record it under the name
      // of the thing it is, so the ordering assertions read as intent.
      calls.push('lockSale')
      Prisma.sql(strings, ...values)
      return []
    },
    $executeRaw: async () => {
      calls.push('$executeRaw')
      return 0
    },
    sale: {
      findUniqueOrThrow: async () => {
        calls.push('sale.findUniqueOrThrow')
        return { status }
      },
      update: async (args: { data: { status: string } }) => {
        calls.push(`sale.update:${args.data.status}`)
        return {}
      }
    },
    scheduleEntry: {
      // The targeted read. `where` is echoed into the call name so the
      // org/sale scoping can be asserted without a second spy.
      findFirst: async (args: { where: { id: string; saleId: string } }) => {
        calls.push(`scheduleEntry.findFirst:${args.where.saleId}/${args.where.id}`)
        return entry && entry.id === args.where.id ? { ...entry } : null
      },
      findMany: async () => {
        calls.push('scheduleEntry.findMany')
        return (
          options.entriesAfterRecompute ??
          ENTRIES.map((e) => ({ amountDueMinor: e.amountDueMinor, amountPaidMinor: e.amountPaidMinor }))
        )
      },
      updateMany: async () => {
        calls.push('scheduleEntry.updateMany')
        return { count: 0 }
      }
    },
    payment: {
      create: async () => {
        calls.push('payment.create')
        return { id: 'payment_1' }
      }
    },
    paymentAllocation: {
      createMany: async (args: {
        data: Array<{ scheduleEntryId: string; amountMinor: bigint }>
      }) => {
        calls.push('paymentAllocation.createMany')
        allocationRows.push(...args.data)
        return { count: args.data.length }
      },
      findMany: async () => {
        calls.push('paymentAllocation.findMany')
        return allocationRows.map((row) => ({
          scheduleEntryId: row.scheduleEntryId,
          amountMinor: row.amountMinor
        }))
      }
    },
    organization: {
      update: async () => {
        calls.push('organization.update')
        return { documentSeq: 7 }
      }
    },
    document: {
      create: async (args: { data: { type: string; number: string; paymentId: string | null } }) => {
        calls.push(`document.create:${args.data.type}`)
        return { id: 'document_1', ...args.data }
      }
    }
  }

  return { tx: tx as unknown as Prisma.TransactionClient, calls, allocationRows }
}

describe('recordPayment orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findFirst.mockResolvedValue({ id: 'sale_1', currency: 'NGN' })
  })

  it('refuses to record against a cancelled sale', async () => {
    const { tx, calls } = fakeTx({ status: 'CANCELLED' })
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    const failure = await recordPayment(actor, input).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ServiceError)
    expect((failure as ServiceError).code).toBe('CONFLICT')
    // Refused before any money moved — no entry read, no payment row, no
    // allocations, no receipt. And the status was re-read under the lock, not
    // before it.
    expect(calls).toEqual(['lockSale', 'sale.findUniqueOrThrow'])
  })

  it('takes the sale lock before reading the entry it allocates against', async () => {
    const { tx, calls } = fakeTx()
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    await recordPayment(actor, input)

    // The lock is first, full stop: both the status re-read and the entry read
    // must happen behind it, or a concurrent writer computes its cap from an
    // outstanding figure that is already stale.
    expect(calls[0]).toBe('lockSale')
    const entryRead = calls.findIndex((call) => call.startsWith('scheduleEntry.findFirst'))
    expect(calls.indexOf('lockSale')).toBeLessThan(calls.indexOf('sale.findUniqueOrThrow'))
    expect(calls.indexOf('lockSale')).toBeLessThan(entryRead)
    expect(entryRead).toBeLessThan(calls.indexOf('payment.create'))
  })

  it('writes exactly one allocation, against the entry that was chosen', async () => {
    const { tx, calls, allocationRows } = fakeTx()
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    const result = await recordPayment(actor, input)

    // The rule, asserted at the only place it can be: what actually reached
    // the database. One row, the chosen entry, the whole amount — nothing
    // cascaded onto e1, which is outstanding and would have been first under
    // the old oldest-first model.
    expect(allocationRows).toEqual([{ paymentId: 'payment_1', scheduleEntryId: 'e2', amountMinor: 30000n }])
    expect(calls.filter((call) => call === 'paymentAllocation.createMany')).toHaveLength(1)
    expect(allocationRows.map((row) => row.scheduleEntryId)).not.toContain('e1')
    expect(result.entrySequence).toBe(2)
    expect(result.amountMinor).toBe(30000n)
  })

  it('applies to a chosen later entry even while earlier ones are unpaid', async () => {
    // Installment 2 paid early while installment 1 is outstanding. Under the
    // cascade this was impossible: the money always went to e1 first.
    const { tx, allocationRows } = fakeTx({
      entry: { id: 'e2', sequence: 2, amountDueMinor: 30000n, amountPaidMinor: 0n }
    })
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    await recordPayment(actor, { ...input, scheduleEntryId: 'e2' })

    expect(allocationRows).toEqual([{ paymentId: 'payment_1', scheduleEntryId: 'e2', amountMinor: 30000n }])
  })

  it('records less than the outstanding, leaving the entry partial', async () => {
    const { tx, allocationRows } = fakeTx()
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    await recordPayment(actor, { ...input, amount: '120' })

    expect(allocationRows).toEqual([{ paymentId: 'payment_1', scheduleEntryId: 'e2', amountMinor: 12000n }])
  })

  it('refuses an amount above the entry outstanding, naming the figure', async () => {
    // The entry owes 250.00 of its 300.00; 300.00 is refused rather than
    // applied-and-cascaded, and the message carries the number the agent has
    // to type instead — that is the whole point of refusing here.
    const { tx, calls } = fakeTx({
      entry: { id: 'e2', sequence: 2, amountDueMinor: 30000n, amountPaidMinor: 5000n }
    })
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    const failure = await recordPayment(actor, input).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ServiceError)
    expect((failure as ServiceError).code).toBe('VALIDATION')
    // Built through formatMinor rather than typed out, because the separator
    // Intl puts between a currency code and its digits is a non-breaking
    // space — a literal here would be a test that fails on an invisible
    // character. The figure itself is asserted plainly underneath.
    expect((failure as ServiceError).message).toBe(
      `Installment 2 has ${formatMinor(25000n, 'NGN')} outstanding — enter that amount or less.`
    )
    expect((failure as ServiceError).message).toContain('250.00')
    // Nothing was written: no payment row, no allocation, no receipt.
    expect(calls).not.toContain('payment.create')
    expect(calls).not.toContain('paymentAllocation.createMany')
    expect(calls).not.toContain('document.create:RECEIPT')
  })

  it('refuses an entry that is already fully paid', async () => {
    const { tx, calls } = fakeTx({
      entry: { id: 'e2', sequence: 2, amountDueMinor: 30000n, amountPaidMinor: 30000n }
    })
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    const failure = await recordPayment(actor, input).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ServiceError)
    expect((failure as ServiceError).message).toBe(
      'Installment 2 is already fully paid — choose an entry that still owes something.'
    )
    expect(calls).not.toContain('payment.create')
  })

  it('treats an entry id from another sale as NOT_FOUND, never applying it', async () => {
    // The forged-id case. The lookup is scoped to this sale, and this sale was
    // already scoped to the actor's org, so someone else's installment matches
    // nothing — the same answer a nonexistent id gets, which is also what stops
    // the response being used to probe what exists.
    const { tx, calls } = fakeTx({ entry: null })
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    const failure = await recordPayment(actor, {
      ...input,
      scheduleEntryId: 'entry_from_another_sale'
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ServiceError)
    expect((failure as ServiceError).code).toBe('NOT_FOUND')
    expect(calls).toContain('scheduleEntry.findFirst:sale_1/entry_from_another_sale')
    expect(calls).not.toContain('payment.create')
    expect(calls).not.toContain('paymentAllocation.createMany')
  })

  it('scopes the entry lookup to the sale it was loaded for', async () => {
    const { tx, calls } = fakeTx()
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    await recordPayment(actor, input)

    expect(calls).toContain('scheduleEntry.findFirst:sale_1/e2')
  })

  it('issues the receipt with the transaction client, not after the commit', async () => {
    const { tx, calls } = fakeTx()
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    const result = await recordPayment(actor, input)

    // Both halves of issuance — claiming the org's next sequence and writing
    // the Document — were issued through the fake tx, which is the only way
    // they could have been recorded here at all. A receipt created after the
    // transaction committed would leave a payment briefly receipt-less, and a
    // failure in between would leave it that way for good.
    expect(calls).toContain('organization.update')
    expect(calls).toContain('document.create:RECEIPT')
    expect(calls.indexOf('payment.create')).toBeLessThan(calls.indexOf('document.create:RECEIPT'))
    expect(result.receiptId).toBe('document_1')
    expect(result.paymentId).toBe('payment_1')
    // The number comes back too, because the confirmation the agent reads
    // names it — see recordPaymentAction.
    expect(result.receiptNumber).toMatch(/^RCP-\d+$/)
  })

  it('returns no overpayment figure, because overpayment cannot happen', async () => {
    const { tx } = fakeTx()
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    const result = await recordPayment(actor, input)

    // Not "returns zero" — the field is gone. A permanently-zero surplus is a
    // trap for the next reader, and the amount is capped at one entry's
    // outstanding, so no surplus can arise to report.
    expect(result).not.toHaveProperty('overpaymentMinor')
  })

  it('completes the sale once the recomputed schedule is fully settled', async () => {
    const { tx, calls } = fakeTx({
      entriesAfterRecompute: [
        { amountDueMinor: 30000n, amountPaidMinor: 30000n },
        { amountDueMinor: 30000n, amountPaidMinor: 30000n }
      ]
    })
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    await recordPayment(actor, input)

    // Derived from the entries as they actually stand, and written inside the
    // same transaction and lock as the allocation itself.
    expect(calls).toContain('sale.update:COMPLETED')
    expect(calls.indexOf('document.create:RECEIPT')).toBeLessThan(
      calls.indexOf('sale.update:COMPLETED')
    )
  })

  it('leaves a still-unsettled sale ACTIVE without writing the status', async () => {
    const { tx, calls } = fakeTx({
      entriesAfterRecompute: [
        { amountDueMinor: 30000n, amountPaidMinor: 30000n },
        { amountDueMinor: 30000n, amountPaidMinor: 0n }
      ]
    })
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    await recordPayment(actor, input)

    expect(calls.some((call) => call.startsWith('sale.update'))).toBe(false)
  })

  it('rejects a sale outside the actor organisation before opening a transaction', async () => {
    findFirst.mockResolvedValue(null)

    const failure = await recordPayment(actor, input).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ServiceError)
    expect((failure as ServiceError).code).toBe('NOT_FOUND')
    expect($transaction).not.toHaveBeenCalled()
  })
})
