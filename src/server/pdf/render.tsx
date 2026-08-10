import { renderToBuffer } from '@react-pdf/renderer'
import { prisma } from '@/server/db'
import { ServiceError } from '@/server/services/errors'
import { InvoiceDocument } from '@/server/pdf/InvoiceDocument'
import { ReceiptDocument } from '@/server/pdf/ReceiptDocument'
import { StatementDocument } from '@/server/pdf/StatementDocument'
import { deriveStatus } from '@/domain/status'
import { summariseSale } from '@/server/services/sales'

/**
 * Bytes are regenerated on demand rather than stored: payments are immutable
 * and schedules are frozen at signing, so a re-download is byte-identical
 * without any blob storage to configure.
 *
 * Returns the filename alongside the buffer (not just `Buffer`, despite the
 * interface note in the task brief) because the download route needs it for
 * `Content-Disposition` and re-deriving it from `doc.number` a second time in
 * the route would just be this function's work duplicated by its only caller.
 */
export async function renderDocumentPdf(
  documentId: string,
  orgId: string
): Promise<{ buffer: Buffer; filename: string }> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, orgId },
    include: {
      org: { select: { name: true } },
      sale: {
        include: {
          project: true,
          unit: true,
          buyer: true,
          scheduleEntries: { orderBy: { sequence: 'asc' } }
        }
      },
      scheduleEntry: true,
      payment: { include: { allocations: { include: { scheduleEntry: true } } } }
    }
  })
  if (!doc) throw new ServiceError('Document not found', 'NOT_FOUND')

  const { sale } = doc
  const summary = summariseSale(sale, new Date())
  const filename = `${doc.number}.pdf`

  if (doc.type === 'INVOICE') {
    const entry = doc.scheduleEntry
    if (!entry) throw new ServiceError('Invoice is missing its installment', 'NOT_FOUND')

    return {
      filename,
      buffer: await renderToBuffer(
        <InvoiceDocument
          number={doc.number}
          issuedAt={doc.createdAt}
          orgName={doc.org.name}
          projectName={sale.project.name}
          unitName={sale.unit.name}
          buyerName={sale.buyer.fullName}
          buyerPhone={sale.buyer.phone}
          buyerEmail={sale.buyer.email}
          currency={sale.currency}
          sequence={entry.sequence}
          totalInstallments={sale.scheduleEntries.length}
          dueDate={entry.dueDate}
          amountDueMinor={entry.amountDueMinor}
          amountPaidMinor={entry.amountPaidMinor}
        />
      )
    }
  }

  if (doc.type === 'RECEIPT') {
    const payment = doc.payment
    if (!payment) throw new ServiceError('Receipt is missing its payment', 'NOT_FOUND')

    return {
      filename,
      buffer: await renderToBuffer(
        <ReceiptDocument
          number={doc.number}
          orgName={doc.org.name}
          projectName={sale.project.name}
          unitName={sale.unit.name}
          buyerName={sale.buyer.fullName}
          currency={sale.currency}
          amountMinor={payment.amountMinor}
          receivedAt={payment.receivedAt}
          method={payment.method}
          reference={payment.reference}
          allocations={payment.allocations.map((a) => ({
            sequence: a.scheduleEntry.sequence,
            dueDate: a.scheduleEntry.dueDate,
            amountMinor: a.amountMinor
          }))}
          balanceMinor={summary.balanceMinor}
          voided={payment.voidedAt !== null}
          voidReason={payment.voidReason}
        />
      )
    }
  }

  if (doc.type !== 'STATEMENT') {
    // Exhaustiveness guard: if `DocumentType` ever gains a fourth member,
    // this is a compile-time error at the `never` assignment below (a new
    // branch must be added above) and, should that check ever be bypassed
    // at runtime (e.g. stale client, direct DB write), a loud failure here
    // instead of silently rendering the wrong PDF as a Statement.
    const exhaustive: never = doc.type
    throw new Error(`Unsupported document type: ${exhaustive as string}`)
  }

  const asOf = new Date()
  return {
    filename,
    buffer: await renderToBuffer(
      <StatementDocument
        number={doc.number}
        orgName={doc.org.name}
        projectName={sale.project.name}
        projectLocation={sale.project.location}
        unitName={sale.unit.name}
        buyerName={sale.buyer.fullName}
        buyerPhone={sale.buyer.phone}
        currency={sale.currency}
        planType={sale.planType}
        priceMinor={sale.priceMinor}
        depositMinor={sale.depositMinor}
        signedAt={sale.signedAt}
        expectedCompletion={sale.project.expectedCompletion}
        entries={sale.scheduleEntries.map((e) => ({
          sequence: e.sequence,
          dueDate: e.dueDate,
          amountDueMinor: e.amountDueMinor,
          amountPaidMinor: e.amountPaidMinor,
          status: deriveStatus(e, asOf)
        }))}
        totalMinor={sale.scheduleEntries.reduce((s, e) => s + e.amountDueMinor, 0n)}
        paidToDateMinor={summary.paidToDateMinor}
        balanceMinor={summary.balanceMinor}
      />
    )
  }
}
