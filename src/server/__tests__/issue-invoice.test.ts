import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceError } from '@/server/services/errors'
import type { SessionActor } from '@/server/session'

/**
 * `issueInvoice` now has four ordered decisions, and the order is the whole
 * point:
 *
 *   1. is this installment the caller's to see at all?  -> NOT_FOUND
 *   2. does an invoice already exist?                   -> return it
 *   3. has anything been paid against it?               -> CONFLICT if not
 *   4. create.
 *
 * (1) before (3) is an information-disclosure property: if the payment gate ran
 * first, "no payment has been recorded" would confirm the existence of an
 * installment to someone with no right to know it exists, and the NOT_FOUND that
 * makes a guessed id indistinguishable from another buyer's would be undone.
 *
 * (2) before (3) is a durability property: an invoice legitimately issued and
 * then voided back to zero must keep downloading.
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

describe('issueInvoice payment gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refuses an installment with nothing paid against it', async () => {
    findFirst.mockResolvedValue(entry({ amountPaidMinor: 0n }))

    const failure = await issueInvoice(staff, 'entry_1').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ServiceError)
    expect((failure as ServiceError).code).toBe('CONFLICT')
    // The message has to tell the user what to do, not just that they cannot.
    expect((failure as ServiceError).message).toMatch(/payment has been recorded/i)
    // Refused before any document was minted, so the org's sequence is not
    // burned by an attempt that could never succeed.
    expect($transaction).not.toHaveBeenCalled()
  })

  it('allows an installment that is only partly paid', async () => {
    findFirst.mockResolvedValue(entry({ amountPaidMinor: 11666667n }))
    creates('doc_new')

    await expect(issueInvoice(staff, 'entry_1')).resolves.toEqual({ documentId: 'doc_new' })
    expect($transaction).toHaveBeenCalledOnce()
  })

  it('allows an installment that is settled in full', async () => {
    findFirst.mockResolvedValue(entry({ amountPaidMinor: 18333333n }))
    creates('doc_new')

    await expect(issueInvoice(staff, 'entry_1')).resolves.toEqual({ documentId: 'doc_new' })
  })

  it('reports NOT_FOUND — not the payment gate — for an installment outside the actor org', async () => {
    // What a cross-org (or nonexistent, or another buyer's) id looks like: the
    // scoped read simply finds nothing. The zero-paid entry it names is real in
    // the database; the point is that this caller learns nothing about it.
    findFirst.mockResolvedValue(null)

    const failure = await issueInvoice(staff, 'entry_in_another_org').catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(ServiceError)
    expect((failure as ServiceError).code).toBe('NOT_FOUND')
    expect((failure as ServiceError).message).not.toMatch(/payment/i)
  })

  it('still returns the existing invoice, even after the payment behind it was voided', async () => {
    // Voiding deletes the allocations, so the entry is back to zero paid — and
    // the document the buyer already has must keep working.
    findFirst.mockResolvedValue(entry({ amountPaidMinor: 0n, document: { id: 'doc_existing' } }))

    await expect(issueInvoice(staff, 'entry_1')).resolves.toEqual({ documentId: 'doc_existing' })
    expect($transaction).not.toHaveBeenCalled()
  })

  it('returns the existing invoice for a still-paid installment without creating a second', async () => {
    findFirst.mockResolvedValue(
      entry({ amountPaidMinor: 11666667n, document: { id: 'doc_existing' } })
    )

    await expect(issueInvoice(staff, 'entry_1')).resolves.toEqual({ documentId: 'doc_existing' })
    expect($transaction).not.toHaveBeenCalled()
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
