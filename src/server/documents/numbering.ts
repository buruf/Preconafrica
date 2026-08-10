import type { DocumentType, Prisma } from '@prisma/client'

const PREFIX: Record<DocumentType, string> = {
  INVOICE: 'INV',
  RECEIPT: 'RCP',
  STATEMENT: 'STM'
}

export function formatDocumentNumber(type: DocumentType, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`sequence must be a positive integer, received ${sequence}`)
  }
  return `${PREFIX[type]}-${String(sequence).padStart(6, '0')}`
}

/**
 * Atomically claims the next number for an organisation. The increment and the
 * read happen in one statement, so two documents issued at the same instant
 * cannot receive the same number.
 */
export async function nextDocumentSequence(
  tx: Prisma.TransactionClient,
  orgId: string
): Promise<number> {
  const org = await tx.organization.update({
    where: { id: orgId },
    data: { documentSeq: { increment: 1 } },
    select: { documentSeq: true }
  })
  return org.documentSeq
}
