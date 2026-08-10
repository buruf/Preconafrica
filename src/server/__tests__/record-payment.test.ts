import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceError } from '@/server/services/errors'
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
 *     can never commit without one.
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

const input = {
  saleId: 'sale_1',
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
 * order they were issued. `status` is what the locked re-read reports, and
 * `entriesAfterRecompute` (when given) is what the post-allocation read in
 * syncSaleStatus sees, which is how the COMPLETED transition is exercised
 * without re-simulating the recompute.
 */
function fakeTx(options: {
  status?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
  entriesAfterRecompute?: Array<{ amountDueMinor: bigint; amountPaidMinor: bigint }>
} = {}) {
  const calls: string[] = []
  const status = options.status ?? 'ACTIVE'
  let scheduleReads = 0

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
      findMany: async () => {
        calls.push('scheduleEntry.findMany')
        scheduleReads += 1
        // The first read is recordPayment's own; the second is syncSaleStatus
        // looking at the entries as they stand after the recompute.
        if (scheduleReads > 1 && options.entriesAfterRecompute) {
          return options.entriesAfterRecompute
        }
        return ENTRIES.map((entry) => ({ ...entry }))
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
      createMany: async (args: { data: unknown[] }) => {
        calls.push('paymentAllocation.createMany')
        return { count: args.data.length }
      },
      findMany: async () => {
        calls.push('paymentAllocation.findMany')
        return [{ scheduleEntryId: 'e1', amountMinor: 30000n }]
      }
    },
    organization: {
      update: async () => {
        calls.push('organization.update')
        return { documentSeq: 7 }
      }
    },
    document: {
      create: async (args: { data: { type: string; paymentId: string | null } }) => {
        calls.push(`document.create:${args.data.type}`)
        return { id: 'document_1', ...args.data }
      }
    }
  }

  return { tx: tx as unknown as Prisma.TransactionClient, calls }
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
    // Refused before any money moved — no payment row, no allocations, no
    // receipt. And the status was re-read under the lock, not before it.
    expect(calls).toEqual(['lockSale', 'sale.findUniqueOrThrow'])
  })

  it('takes the sale lock before reading the schedule it allocates against', async () => {
    const { tx, calls } = fakeTx()
    $transaction.mockImplementation((callback: (tx: Prisma.TransactionClient) => unknown) =>
      callback(tx)
    )

    await recordPayment(actor, input)

    // The lock is first, full stop: both the status re-read and the schedule
    // read must happen behind it, or a concurrent writer allocates against a
    // schedule that is already stale.
    expect(calls[0]).toBe('lockSale')
    expect(calls.indexOf('lockSale')).toBeLessThan(calls.indexOf('sale.findUniqueOrThrow'))
    expect(calls.indexOf('lockSale')).toBeLessThan(calls.indexOf('scheduleEntry.findMany'))
    expect(calls.indexOf('scheduleEntry.findMany')).toBeLessThan(calls.indexOf('payment.create'))
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
    // same transaction and lock as the allocations themselves.
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
