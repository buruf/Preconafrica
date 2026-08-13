import { renderToBuffer } from '@react-pdf/renderer'
import { prisma } from '@/server/db'
import { ServiceError } from '@/server/services/errors'
import { InvoiceDocument } from '@/server/pdf/InvoiceDocument'
import { ReceiptDocument } from '@/server/pdf/ReceiptDocument'
import { StatementDocument } from '@/server/pdf/StatementDocument'
import { deriveStatus } from '@/domain/status'
import { computeMarkupMinor } from '@/domain/schedule'
import { summariseSale } from '@/server/services/sales'
import { fetchGuardedImages, toPdfImage } from '@/server/media/images'

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
      org: { select: { name: true, logoUrl: true } },
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
  // One instant for the whole render, the same way the pages do it: every
  // derived status and the summary must agree on "now", or a row could be
  // stamped PENDING while a total above it was computed a heartbeat later as
  // OVERDUE.
  const asOf = new Date()
  const summary = summariseSale(sale, asOf)
  const filename = `${doc.number}.pdf`

  // Every image this document might carry, fetched once, concurrently, *before*
  // any rendering starts. Three reasons it is here and not inside a component:
  // @react-pdf's render is synchronous and would otherwise reach out to the
  // network mid-layout; a URL handed straight to `Image` bypasses the SSRF guard
  // entirely; and the two fetches are independent, so they should cost one
  // round trip's latency rather than two.
  //
  // The logo is fetched for every type, because all three carry the same
  // masthead — see `Masthead`. It used to be fetched for INVOICE only, which
  // left the developer's letterhead off the statement a buyer keeps and off
  // every receipt while a comment in `Masthead` said the opposite.
  //
  // The hero photo is still narrowed to the statement, and that narrowing is the
  // reason this is a per-type map rather than an unconditional fetch: it is the
  // only document with a band to put a building in, and up to five seconds of
  // timeout for an image nothing renders is latency a buyer pays for nothing. A
  // null URL short-circuits before any network call, so an org with no logo set
  // costs nothing either. `toPdfImage` then applies the document-size budget and
  // the PNG/JPEG-only rule; anything it rejects becomes null, which every
  // consumer below already renders as its placeholder.
  const fetched = await fetchGuardedImages({
    logo: doc.org.logoUrl,
    hero: doc.type === 'STATEMENT' ? sale.project.heroImageUrl : null
  })
  const logo = toPdfImage(fetched.logo)
  const heroImage = toPdfImage(fetched.hero)

  if (doc.type === 'INVOICE') {
    const entry = doc.scheduleEntry
    if (!entry) throw new ServiceError('Invoice is missing its installment', 'NOT_FOUND')

    // No allocation query here, deliberately. An invoice is a demand for
    // payment, not a proof of one: the only figures it needs are the entry's
    // own `amountDueMinor` and `amountPaidMinor`, both already loaded above.
    // The itemised trail — dates, methods, references, who recorded what — is
    // the receipt's, and rendering it on both made the two documents say the
    // same thing with different authority.
    return {
      filename,
      buffer: await renderToBuffer(
        <InvoiceDocument
          number={doc.number}
          issuedAt={doc.createdAt}
          orgName={doc.org.name}
          logo={logo}
          projectName={sale.project.name}
          projectLocation={sale.project.location}
          unitName={sale.unit.name}
          buyerName={sale.buyer.fullName}
          buyerPhone={sale.buyer.phone}
          buyerEmail={sale.buyer.email}
          buyerAddress={sale.buyer.address}
          currency={sale.currency}
          sequence={entry.sequence}
          // The contract's months, not the schedule's rows: a deposit adds an
          // entry without adding a month, so `scheduleEntries.length` printed
          // "3 of 37" on every 36-month sale that carried one.
          termMonths={sale.termMonths}
          dueDate={entry.dueDate}
          amountDueMinor={entry.amountDueMinor}
          amountPaidMinor={entry.amountPaidMinor}
          // The same instant `summariseSale` above used, so the status mark on
          // the invoice cannot disagree with any other figure on it.
          status={deriveStatus(entry, asOf)}
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
          logo={logo}
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

  return {
    filename,
    buffer: await renderToBuffer(
      <StatementDocument
        number={doc.number}
        orgName={doc.org.name}
        logo={logo}
        projectName={sale.project.name}
        projectLocation={sale.project.location}
        unitName={sale.unit.name}
        heroImage={heroImage}
        buyerName={sale.buyer.fullName}
        buyerPhone={sale.buyer.phone}
        currency={sale.currency}
        planType={sale.planType}
        termMonths={sale.termMonths}
        priceMinor={sale.priceMinor}
        depositMinor={sale.depositMinor}
        markupBps={sale.markupBps}
        // Recomputed from the sale's own signing snapshot, the same way the
        // dashboards do it, rather than inferred from the schedule total —
        // one arithmetic, three stored numbers, no figure to drift.
        markupMinor={
          sale.markupBps > 0
            ? computeMarkupMinor(sale.priceMinor - sale.depositMinor, sale.markupBps)
            : 0n
        }
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
