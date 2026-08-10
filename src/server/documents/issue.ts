import type { DocumentType, Prisma } from '@prisma/client'
import { prisma } from '@/server/db'
import { type SessionActor } from '@/server/session'
import { ServiceError } from '@/server/services/errors'
import { formatDocumentNumber, nextDocumentSequence } from '@/server/documents/numbering'

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

/** Idempotent: a second request for the same installment returns the first invoice. */
export async function issueInvoice(actor: SessionActor, scheduleEntryId: string) {
  const entry = await prisma.scheduleEntry.findFirst({
    where: { id: scheduleEntryId, sale: { orgId: actor.orgId } },
    include: { sale: { select: { id: true } }, document: true }
  })
  if (!entry) throw new ServiceError('Installment not found', 'NOT_FOUND')

  if (entry.document) return { documentId: entry.document.id }

  const doc = await prisma.$transaction((tx) =>
    createDocument(tx, {
      orgId: actor.orgId,
      saleId: entry.sale.id,
      type: 'INVOICE',
      scheduleEntryId: entry.id
    })
  )
  return { documentId: doc.id }
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

export async function issueStatement(actor: SessionActor, saleId: string) {
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, orgId: actor.orgId },
    include: { documents: { where: { type: 'STATEMENT' } } }
  })
  if (!sale) throw new ServiceError('Sale not found', 'NOT_FOUND')
  if (sale.documents[0]) return { documentId: sale.documents[0].id }

  const doc = await prisma.$transaction((tx) =>
    createDocument(tx, { orgId: actor.orgId, saleId: sale.id, type: 'STATEMENT' })
  )
  return { documentId: doc.id }
}
