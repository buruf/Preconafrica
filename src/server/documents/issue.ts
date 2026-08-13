import { Prisma, type DocumentType } from '@prisma/client'
import { prisma } from '@/server/db'
import { type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { formatDocumentNumber, nextDocumentSequence } from '@/server/documents/numbering'
import { lockSale } from '@/server/services/allocations'
import { constraintTargetIncludes } from '@/server/services/units'

async function createDocument(
  tx: Prisma.TransactionClient,
  args: {
    orgId: string
    saleId: string
    type: DocumentType
    scheduleEntryId?: string
    paymentId?: string
  }
) {
  const sequence = await nextDocumentSequence(tx, args.orgId)
  return tx.document.create({
    data: {
      orgId: args.orgId,
      saleId: args.saleId,
      type: args.type,
      number: formatDocumentNumber(args.type, sequence),
      sequence,
      scheduleEntryId: args.scheduleEntryId ?? null,
      paymentId: args.paymentId ?? null
    }
  })
}

/**
 * An invoice is an ordinary demand for payment: issuable for any installment on
 * the schedule, whatever has or has not been paid against it. A bill is the
 * thing you send *before* the money arrives, so gating it on an allocated
 * payment made it impossible to ask for the one thing an invoice exists to ask
 * for. The document that proves a payment is the receipt — `issueReceipt`
 * below mints one inside the payment transaction, and it is the receipt, not
 * this, that carries the method, the reference and the applied-to breakdown.
 *
 * Idempotent: a second request for the same installment returns the first
 * invoice.
 *
 * The pre-check below (`entry.document`) is only a read, not a lock, so two
 * genuinely concurrent requests can both see it as null and both reach the
 * transaction. That is fine — `Document.scheduleEntryId` is `@unique`, so
 * only one create can win; the loser gets `P2002`. The catch below turns
 * that loss into the same success the winner got: re-read the document the
 * winner just created and return it, rather than letting the race surface
 * as a 500 to a buyer who simply tapped twice.
 *
 * Scoping: staff act for the whole organisation, but a BUYER may only ever
 * touch their own sale. Org scoping alone is not enough for them — every buyer
 * in an org shares that orgId, so a guessed scheduleEntryId would let one buyer
 * mint (and then, via /api/documents/[id], read) an invoice belonging to
 * someone else's contract. The extra `sale.buyerId` predicate makes another
 * buyer's installment come back NOT_FOUND, the same answer a nonexistent id
 * gets, so the response cannot be used to probe what exists.
 */
export async function issueInvoice(actor: SessionActor, scheduleEntryId: string) {
  // undefined for staff, which Prisma reads as "no constraint on buyerId" —
  // the narrowing applies only to the role it is about. A BUYER session
  // without a buyerId cannot happen (requireBuyer refuses it) but is refused
  // here too rather than quietly widening back to org scope.
  let buyerId: string | undefined
  if (actor.role === 'BUYER') {
    if (!actor.buyerId) throw new ServiceError('You do not have access to this resource.', 'FORBIDDEN')
    buyerId = actor.buyerId
  }

  const entry = await prisma.scheduleEntry.findFirst({
    where: { id: scheduleEntryId, sale: { orgId: actor.orgId, buyerId } },
    include: { sale: { select: { id: true } }, document: true }
  })
  if (!entry) throw new ServiceError('Installment not found', 'NOT_FOUND')

  // An invoice that was legitimately issued stays downloadable whatever happens
  // to the money afterwards — the document a buyer already holds must not turn
  // into a 404 on their next tap. Idempotency is about the document, not the
  // balance, which is also why nothing about `amountPaidMinor` is read here.
  if (entry.document) return { documentId: entry.document.id }

  try {
    const doc = await prisma.$transaction((tx) =>
      createDocument(tx, {
        orgId: actor.orgId,
        saleId: entry.sale.id,
        type: 'INVOICE',
        scheduleEntryId: entry.id
      })
    )
    return { documentId: doc.id }
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      constraintTargetIncludes(error.meta?.target, 'scheduleEntryId')
    ) {
      const winner = await prisma.document.findFirst({ where: { scheduleEntryId: entry.id } })
      if (winner) return { documentId: winner.id }
    }
    throw error
  }
}

/** Called inside the payment transaction, so a receipt always exists for a payment. */
export async function issueReceipt(
  tx: Prisma.TransactionClient,
  orgId: string,
  saleId: string,
  paymentId: string
) {
  const doc = await createDocument(tx, { orgId, saleId, type: 'RECEIPT', paymentId })
  return { documentId: doc.id }
}

/**
 * Idempotent, and — unlike `issueInvoice` — actually serialised: `Document`
 * has no unique constraint that pairs a STATEMENT with its sale (only the
 * non-unique `@@index([saleId, type])`), so two concurrent requests could
 * otherwise both pass a check-then-create and both succeed, leaving two
 * STATEMENT rows for one sale with no error and nothing to self-heal.
 *
 * The fix is the same row lock `recordPayment`/`voidPayment` take on `Sale`
 * (see `lockSale` in payments.ts), taken *before* the existence check and
 * *inside* the transaction that may create the document. A second concurrent
 * caller blocks on the lock until the first commits, then its own check (run
 * fresh, under the lock, not the stale pre-transaction read `issueInvoice`
 * uses) finds the first caller's statement and returns it without creating a
 * second one.
 */
export async function issueStatement(actor: SessionActor, saleId: string) {
  const saleExists = await prisma.sale.findFirst({
    where: { id: saleId, orgId: actor.orgId },
    select: { id: true }
  })
  if (!saleExists) throw new ServiceError('Sale not found', 'NOT_FOUND')

  const doc = await prisma.$transaction(async (tx) => {
    await lockSale(tx, saleId)

    const existing = await tx.document.findFirst({ where: { saleId, type: 'STATEMENT' } })
    if (existing) return existing

    try {
      return await createDocument(tx, { orgId: actor.orgId, saleId, type: 'STATEMENT' })
    } catch (error) {
      // Belt-and-braces behind the lock above, which already makes this
      // unreachable in practice: the lock serialises every concurrent
      // caller for this sale onto the check-then-create above, so no two
      // of them can both reach `createDocument`. Kept anyway so a future
      // change to this function fails safe instead of surfacing a raw
      // 500. The only unique constraint a STATEMENT create can violate is
      // `Document@@unique([orgId, number])` — `scheduleEntryId` and
      // `paymentId` are both null for a statement, and Postgres does not
      // treat NULLs as colliding in a unique index.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        constraintTargetIncludes(error.meta?.target, 'number')
      ) {
        const raced = await tx.document.findFirst({ where: { saleId, type: 'STATEMENT' } })
        if (raced) return raced
      }
      throw error
    }
  })
  return { documentId: doc.id }
}
