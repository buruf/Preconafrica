import Link from 'next/link'
import { requireBuyer } from '@/server/session'
import { getSaleForBuyer, saleFeeConfig, summariseSale } from '@/server/services/sales'
import { deriveStatus } from '@/domain/status'
import {
  computeInstallmentFeeMinor,
  installmentFeeRateSuffix,
  isFreeInstallmentFee,
  scheduleEntryLabel
} from '@/domain/schedule'
import { formatMinor } from '@/domain/currency'
import { Card, MoneyPair, PageHeader, ProgressBar, StatCard, StatusPill } from '@/components/ui'
import { MediaImage, UnitImagery } from '@/components/media'
import { InvoiceControl } from './InvoiceControl'

const date = (d: Date) => d.toISOString().slice(0, 10)

/**
 * The buyer's contract in full: what they owe, how far through it they are, the
 * thing they bought, and every entry and payment behind the figures.
 *
 * Restyled to the mockup. Outstanding balance is the hero on a filled navy card
 * because it is the one number a buyer opens this screen for — it used to be the
 * third of four equal white boxes, under "Total owed", which is the figure they
 * agreed once and never need again. Total owed is still here, under the progress
 * bar, where it belongs: as context for the fraction rather than as the headline.
 *
 * Server-rendered end to end. Every amount passes through `formatMinor` here, so
 * no bigint crosses into `InvoiceControl`.
 */
export default async function BuyerDashboard() {
  const actor = await requireBuyer()
  const sale = await getSaleForBuyer(actor)

  if (!sale) {
    return (
      <Card>
        <p className="text-sm text-muted">You do not have a unit yet.</p>
      </Card>
    )
  }

  // One instant for the whole page: every deriveStatus call and the summary
  // must agree on "now", or a row could show PENDING while the overdue count
  // above it was computed a heartbeat later as OVERDUE.
  const asOf = new Date()
  const summary = summariseSale(sale, asOf)
  const money = (amount: bigint) => formatMinor(amount, sale.currency)
  const statement = sale.documents.find((d) => d.type === 'STATEMENT')

  // The progress bar's numerator: entries that are fully settled, which is
  // exactly what `deriveStatus` calls PAID (`outstandingMinor === 0`). Derived
  // from the same function the pill beside each row uses, so the count can never
  // disagree with the badges under it — and the deposit is sequence 0, an
  // ordinary entry in this array, so it counts in both the numerator and the
  // denominator like every other thing the buyer owes.
  const paidEntries = sale.scheduleEntries.filter(
    (entry) => deriveStatus(entry, asOf) === 'PAID'
  ).length

  // The buyer's own copy of the fee they agreed to. Recomputed from the sale's
  // signing snapshot rather than inferred by subtracting the price from the
  // schedule total, so the figure here, on the staff page and on the statement
  // all come from the same arithmetic on the same stored numbers.
  const saleFee = saleFeeConfig(sale)
  const feeMinor = isFreeInstallmentFee(saleFee)
    ? 0n
    : computeInstallmentFeeMinor(sale.priceMinor - sale.depositMinor, saleFee)

  // `documents` is the sale's flat list, not a per-entry relation, so build the
  // lookup once instead of scanning it for every schedule row — same approach
  // as the staff sale page.
  const invoiceByEntryId = new Map(
    sale.documents
      .filter((doc) => doc.type === 'INVOICE' && doc.scheduleEntryId)
      .map((doc) => [doc.scheduleEntryId as string, doc.id])
  )

  return (
    <>
      <PageHeader
        title={`Unit ${sale.unit.name}`}
        subtitle={`${sale.project.name} · ${sale.project.location}`}
      />

      {/* The building, then the balance. A buyer signed a contract for something
          that does not exist yet; the one thing they came here for besides the
          numbers is a picture of it. */}
      <div className="mb-4">
        <MediaImage
          kind="building"
          src={sale.project.heroImageUrl}
          alt={`${sale.project.name}, ${sale.project.location}`}
        />
      </div>

      <StatCard
        className="mb-4"
        surface="navy"
        size="hero"
        label="Outstanding balance"
        value={money(summary.balanceMinor)}
        sub={
          summary.overdueCount > 0
            ? `${summary.overdueCount} payment${summary.overdueCount === 1 ? '' : 's'} overdue`
            : undefined
        }
      />

      <Card className="mb-4">
        <MoneyPair label="Paid to date" value={money(summary.paidToDateMinor)} tone="good" />
        <div className="my-3 h-px bg-line" />
        <MoneyPair
          label={summary.nextDue ? `Next due ${date(summary.nextDue.dueDate)}` : 'Next due'}
          value={summary.nextDue ? money(summary.nextDue.amountMinor) : 'Fully paid'}
          tone={summary.nextDue ? 'default' : 'good'}
        />

        <ProgressBar
          className="mt-4"
          value={paidEntries}
          total={sale.scheduleEntries.length}
          noun="paid"
        />

        <div className="mt-4 border-t border-line pt-3">
          <MoneyPair label="Total owed" value={money(summary.totalOwedMinor)} />
          {feeMinor > 0n ? (
            // Empty suffix for a flat fee — see the staff twin, and
            // `installmentFeeRateSuffix`. A buyer whose developer charges a fixed
            // amount must never be shown a rate: deriving one would put the
            // interest framing back on the page for a developer who chose this
            // mode precisely so it would not be there.
            <p className="mt-1 text-[13px] text-muted">
              includes {money(feeMinor)} installment charge
              {installmentFeeRateSuffix(saleFee)}
            </p>
          ) : null}
        </div>
      </Card>

      {statement ? (
        <Link
          href={`/api/documents/${statement.id}`}
          className="mb-4 inline-flex min-h-11 items-center text-sm font-semibold text-navy-900 underline"
        >
          Download my payment statement (PDF)
        </Link>
      ) : null}

      <Card className="mb-6">
        <UnitImagery
          unitName={sale.unit.name}
          projectName={sale.project.name}
          layoutImageUrl={sale.unit.layoutImageUrl}
          renderImageUrls={sale.unit.renderImageUrls}
          heading="Your unit"
        />
      </Card>

      <h2 className="mb-2 text-base font-semibold text-navy-900">Payment schedule</h2>
      <Card className="p-0">
        <ul className="divide-y divide-line">
          {sale.scheduleEntries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                {/* `scheduleEntryLabel` keeps sequence 0 reading as "Deposit"
                    here and on every document; "0." above the signing-day amount
                    reads like a bug. */}
                <p className="text-[15px] font-semibold tabular-nums text-ink">
                  {scheduleEntryLabel(entry.sequence)} · {date(entry.dueDate)}
                </p>
                <p className="text-[13px] tabular-nums text-muted">
                  {money(entry.amountPaidMinor)} of {money(entry.amountDueMinor)} paid
                </p>
              </div>
              <div className="flex items-center gap-3">
                <StatusPill status={deriveStatus(entry, asOf)} />
                <InvoiceControl
                  scheduleEntryId={entry.id}
                  documentId={invoiceByEntryId.get(entry.id) ?? null}
                />
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <h2 className="mb-2 mt-6 text-base font-semibold text-navy-900">Payment history</h2>
      {sale.payments.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">No payments recorded yet.</p>
        </Card>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-line">
            {sale.payments.map((payment) => (
              <li key={payment.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p
                    className={`text-[15px] font-semibold tabular-nums ${
                      payment.voidedAt ? 'text-muted line-through' : 'text-ink'
                    }`}
                  >
                    {money(payment.amountMinor)}
                  </p>
                  <p className="text-[13px] tabular-nums text-muted">
                    {date(payment.receivedAt)} · {payment.method.replace(/_/g, ' ').toLowerCase()}
                    {payment.reference ? ` · ${payment.reference}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {/* A voided payment keeps its row — a receipt that vanished
                      would be worse than one struck through — and says so in the
                      overdue red, which is the palette's "this is a problem". */}
                  {payment.voidedAt ? <StatusPill status="OVERDUE">Voided</StatusPill> : null}
                  {payment.document ? (
                    <Link
                      href={`/api/documents/${payment.document.id}`}
                      className="inline-flex min-h-11 items-center text-sm font-semibold text-navy-900 underline"
                    >
                      Receipt
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}
