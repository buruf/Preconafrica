import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceError } from '@/server/services/errors'
import type { SessionActor } from '@/server/session'

/**
 * `issueInvoice` has three ordered decisions, and the order is the whole point:
 *
 *   1. is this installment the caller's to see at all?  -> NOT_FOUND
 *   2. does an invoice already exist?                   -> return it
 *   3. create.
 *
 * (1) coming first is an information-disclosure property: another buyer's
 * scheduleEntryId, a cross-org one and a nonexistent one must all be
 * indistinguishable, so nothing may answer before the scoped read has.
 *
 * (2) is idempotency: a buyer who taps twice, or an agent re-billing the same
 * month, gets the document that already exists rather than a second one. The
 * unique constraint behind it is what makes a genuine race safe, and the P2002
 * path is exercised below.
 *
 * There is deliberately no fourth decision. An invoice is an ordinary demand
 * for payment, so what has been allocated against the installment is none of
 * this function's business — the receipt is the payment-proof document. The
 * zero-paid cases below pin that: they must succeed, not be refused.
 *
 * A fake prisma is what makes the *order* assertable — every case here is about
 * which check fired, not about arithmetic.
 */
vi.mock('@/server/db', () => ({
  prisma: {
    scheduleEntry: { findFirst: vi.fn() },
    document: { findFirst: vi.fn() },
    $transaction: vi.fn()
  }
}))

const { prisma } = await import('@/server/db')
const { issueInvoice } = await import('@/server/documents/issue')

const findFirst = prisma.scheduleEntry.findFirst as unknown as ReturnType<typeof vi.fn>
const documentFindFirst = prisma.document.findFirst as unknown as ReturnType<typeof vi.fn>
const $transaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>

const staff: SessionActor = {
  userId: 'user_1',
  orgId: 'org_1',
  role: 'AGENT',
  buyerId: null,
  fullName: 'Tunde Bakare',
  email: 'agent@sunrise.test'
}

function entry(overrides: {
  amountPaidMinor: bigint
  document?: { id: string } | null
}) {
  return {
    id: 'entry_1',
    sequence: 2,
    dueDate: new Date('2026-03-10T00:00:00Z'),
    amountDueMinor: 18333333n,
    amountPaidMinor: overrides.amountPaidMinor,
    sale: { id: 'sale_1' },
    document: overrides.document ?? null
  }
}

/** Stands in for the create, and records that it happened. */
function creates(documentId: string) {
  $transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
    await callback({
      organization: { update: async () => ({ documentSeq: 18 }) },
      document: { create: async () => ({ id: documentId }) }
    })
    return { id: documentId }
  })
}

describe('issueInvoice is a demand for payment, not a proof of one', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('issues for an installment with nothing paid against it', async () => {
    // The behaviour this whole file exists to pin. A bill is the thing you send
    // *before* the money arrives; refusing one until a payment had been recorded
    // made the platform unable to ask for the payment in the first place.
    findFirst.mockResolvedValue(entry({ amountPaidMinor: 0n }))
    creates('doc_new')

    await expect(issueInvoice(staff, 'entry_1')).resolves.toEqual({ documentId: 'doc_new' })
    expect($transaction).toHaveBeenCalledOnce()
  })

  it('issues for an installment that is only partly paid', async () => {
    findFirst.mockResolvedValue(entry({ amountPaidMinor: 11666667n }))
    creates('doc_new')

    await expect(issueInvoice(staff, 'entry_1')).resolves.toEqual({ documentId: 'doc_new' })
    expect($transaction).toHaveBeenCalledOnce()
  })

  it('issues for an installment that is settled in full', async () => {
    findFirst.mockResolvedValue(entry({ amountPaidMinor: 18333333n }))
    creates('doc_new')

    await expect(issueInvoice(staff, 'entry_1')).resolves.toEqual({ documentId: 'doc_new' })
  })

  it('never reads the paid amount to decide anything', async () => {
    // Belt-and-braces against the gate creeping back in a different shape: a
    // getter that throws if anything touches the field. Whatever it does with
    // the entry, `issueInvoice` must not consult what has been paid.
    const trap = {
      ...entry({ amountPaidMinor: 0n }),
      get amountPaidMinor(): bigint {
        throw new Error('issueInvoice must not read amountPaidMinor')
      }
    }
    findFirst.mockResolvedValue(trap)
    creates('doc_new')

    await expect(issueInvoice(staff, 'entry_1')).resolves.toEqual({ documentId: 'doc_new' })
  })
})

describe('issueInvoice scoping and idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports NOT_FOUND for an installment outside the actor org', async () => {
    // What a cross-org (or nonexistent, or another buyer's) id looks like: the
    // scoped read simply finds nothing, and nothing downstream may answer first.
    findFirst.mockResolvedValue(null)

    const failure = await issueInvoice(staff, 'entry_in_another_org').catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(ServiceError)
    expect((failure as ServiceError).code).toBe('NOT_FOUND')
    expect($transaction).not.toHaveBeenCalled()
  })

  it('returns the existing invoice without creating a second', async () => {
    findFirst.mockResolvedValue(
      entry({ amountPaidMinor: 11666667n, document: { id: 'doc_existing' } })
    )

    await expect(issueInvoice(staff, 'entry_1')).resolves.toEqual({ documentId: 'doc_existing' })
    expect($transaction).not.toHaveBeenCalled()
  })

  it('still returns the existing invoice after the payment behind it was voided', async () => {
    // Voiding deletes the allocations, so the entry is back to zero paid — and
    // the document the buyer already holds must keep working.
    findFirst.mockResolvedValue(entry({ amountPaidMinor: 0n, document: { id: 'doc_existing' } }))

    await expect(issueInvoice(staff, 'entry_1')).resolves.toEqual({ documentId: 'doc_existing' })
    expect($transaction).not.toHaveBeenCalled()
  })

  it('turns a lost create race into the winner’s document rather than a 500', async () => {
    // Two taps land at once: the pre-check is a read, not a lock, so both reach
    // the transaction and `Document.scheduleEntryId @unique` decides. The loser
    // must get the same success the winner got.
    const { Prisma } = await import('@prisma/client')
    findFirst.mockResolvedValue(entry({ amountPaidMinor: 0n }))
    $transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['scheduleEntryId'] }
      })
    )
    documentFindFirst.mockResolvedValue({ id: 'doc_winner' })

    await expect(issueInvoice(staff, 'entry_1')).resolves.toEqual({ documentId: 'doc_winner' })
    expect(documentFindFirst).toHaveBeenCalledWith({ where: { scheduleEntryId: 'entry_1' } })
  })

  it('rethrows a P2002 on some other constraint rather than claiming a race', async () => {
    const { Prisma } = await import('@prisma/client')
    findFirst.mockResolvedValue(entry({ amountPaidMinor: 0n }))
    $transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['orgId', 'number'] }
      })
    )

    await expect(issueInvoice(staff, 'entry_1')).rejects.toThrow(/Unique constraint failed/)
    expect(documentFindFirst).not.toHaveBeenCalled()
  })

  it('refuses a BUYER session with no buyerId before reading anything', async () => {
    const brokenBuyer: SessionActor = { ...staff, role: 'BUYER', buyerId: null }

    const failure = await issueInvoice(brokenBuyer, 'entry_1').catch((error: unknown) => error)

    expect((failure as ServiceError).code).toBe('FORBIDDEN')
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('scopes a buyer read to their own sale', async () => {
    findFirst.mockResolvedValue(entry({ amountPaidMinor: 11666667n }))
    creates('doc_new')

    await issueInvoice({ ...staff, role: 'BUYER', buyerId: 'buyer_9' }, 'entry_1')

    expect(findFirst.mock.calls[0][0].where).toEqual({
      id: 'entry_1',
      sale: { orgId: 'org_1', buyerId: 'buyer_9' }
    })
  })
})
