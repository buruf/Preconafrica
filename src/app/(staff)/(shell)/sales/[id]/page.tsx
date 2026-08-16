import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireStaff } from '@/server/session'
import { getSaleForStaff, saleFeeConfig, summariseSale } from '@/server/services/sales'
import { ServiceError } from '@/server/services/errors'
import { deriveStatus } from '@/domain/status'
import {
  computeInstallmentFeeMinor,
  installmentFeeRateSuffix,
  isFreeInstallmentFee,
  scheduleEntryLabel,
  scheduleEntryTitle
} from '@/domain/schedule'
import { formatMinor } from '@/domain/currency'
import { Card, MoneyPair, PageHeader, ProgressBar, StatCard, StatusPill } from '@/components/ui'
import { UnitImagery } from '@/components/media'
import { PaymentForm, type PayableEntry } from './PaymentForm'
import { VoidControl } from './VoidControl'
import { InvoiceControl } from './InvoiceControl'

// The payment-recording action executes under this page's route, and
// @react-pdf/renderer's receipt render (inside recordPayment's own
// transaction) is the slowest step in that path — see the confirm page and
// the documents route for the same reasoning. `'use server'` files cannot
// export segment config, so the budget lives here.
export const maxDuration = 30

const date = (d: Date) => d.toISOString().slice(0, 10)

export default async function StaffSalePage({ params }: { params: { id: string } }) {
  const actor = await requireStaff()

  // A missing or cross-org sale is a routing miss, not an application error —
  // notFound() renders Next's clean not-found page instead of tripping the
  // (staff) error boundary's "Access denied" message, which would otherwise
  // be misleading here (the actor is authorized; the sale just is not theirs
  // to find). Any other ServiceError (there are none from this call today,
  // but the contract may grow one) still propagates to the error boundary.
  let sale: Awaited<ReturnType<typeof getSaleForStaff>>
  try {
    sale = await getSaleForStaff(actor, params.id)
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'NOT_FOUND') notFound()
    throw error
  }

  // One instant for the whole page — see the buyer dashboard for why every
  // deriveStatus call and the summary must agree on "now".
  const asOf = new Date()
  const summary = summariseSale(sale, asOf)
  const money = (amount: bigint) => formatMinor(amount, sale.currency)

  // Recomputed from the sale's own snapshot — price, deposit and the whole fee
  // config were all frozen at signing — rather than inferred by subtracting the
  // price from the schedule total, so the line stays right even if a row were
  // ever hand-repaired. Without it, a charged sale simply reads as owing more
  // than the unit cost, with nothing on the page explaining why.
  const saleFee = saleFeeConfig(sale)
  const feeMinor = isFreeInstallmentFee(saleFee)
    ? 0n
    : computeInstallmentFeeMinor(sale.priceMinor - sale.depositMinor, saleFee)

  // The progress bar's numerator: entries that are fully settled, which is
  // exactly what `deriveStatus` calls PAID. Derived from the same function the
  // pill beside each row uses, and from the same `asOf`, so the fraction and the
  // badges under it cannot disagree — the buyer's dashboard computes it the same
  // way for the same reason.
  const paidEntries = sale.scheduleEntries.filter(
    (entry) => deriveStatus(entry, asOf) === 'PAID'
  ).length

  // What the payment form may be pointed at: the entries that still owe
  // something, in schedule order (getSaleForStaff already sorts by sequence),
  // each labelled here on the server.
  //
  // Every field is a string. A `bigint` cannot cross into a client component at
  // all, and a `number` would be the one float in a money path — so the
  // outstanding figure travels twice, once as exact minor units for the
  // client's own cap check and once already through `formatMinor` for display.
  // A settled entry is not offered at all: an option that can only be refused
  // is not a choice.
  const payableEntries: PayableEntry[] = sale.scheduleEntries
    .filter((entry) => entry.amountDueMinor > entry.amountPaidMinor)
    .map((entry) => {
      const outstandingMinor = entry.amountDueMinor - entry.amountPaidMinor
      const title = scheduleEntryTitle(entry.sequence)
      return {
        id: entry.id,
        title,
        label: `${title} — due ${date(entry.dueDate)} — ${money(outstandingMinor)} outstanding`,
        outstandingMinor: outstandingMinor.toString(),
        outstandingLabel: money(outstandingMinor)
      }
    })

  // getSaleForStaff includes `documents` as the sale's flat list, not a
  // per-entry relation — build the lookup once rather than scanning the list
  // for every row.
  const invoiceByEntryId = new Map(
    sale.documents
      .filter((doc) => doc.type === 'INVOICE' && doc.scheduleEntryId)
      .map((doc) => [doc.scheduleEntryId as string, doc.id])
  )

  return (
    <>
      <PageHeader
        title={sale.buyer.fullName}
        subtitle={`Unit ${sale.unit.name} · ${sale.project.name}`}
        action={
          // Staff chase arrears by phone, so the number is a tap-to-call link
          // right in the header, not buried in a details card.
          <a
            href={`tel:${sale.buyer.phone}`}
            className="inline-flex min-h-11 items-center text-[15px] font-semibold tabular-nums text-navy-900 underline"
          >
            {sale.buyer.phone}
          </a>
        }
      />

      {/* The balance leads, on the filled navy card, exactly as it does on the
          buyer's own dashboard — an agent on an arrears call and the buyer they
          are calling are looking at the same headline figure. */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          className="sm:col-span-1"
          surface="navy"
          size="hero"
          label="Balance"
          value={money(summary.balanceMinor)}
          sub={
            summary.overdueCount > 0
              ? `${summary.overdueCount} payment${summary.overdueCount === 1 ? '' : 's'} overdue`
              : undefined
          }
        />
        <StatCard
          label="Paid to date"
          tone="good"
          value={money(summary.paidToDateMinor)}
          sub={`of ${money(summary.totalOwedMinor)} owed`}
        />
        <StatCard
          label="Next payment due"
          value={summary.nextDue ? money(summary.nextDue.amountMinor) : 'Fully paid'}
          tone={summary.nextDue ? 'default' : 'good'}
          sub={summary.nextDue ? `on ${date(summary.nextDue.dueDate)}` : undefined}
        />
      </div>

      <Card className="mb-5">
        <MoneyPair label="Total owed" value={money(summary.totalOwedMinor)} />
        {feeMinor > 0n ? (
          // The rate suffix is empty for a flat fee, by design — a FIXED
          // charge has no percentage, and inventing one for display would be
          // the interest framing this mode exists to avoid.
          <p className="mt-1 text-[13px] text-muted">
            includes {money(feeMinor)} installment charge
            {installmentFeeRateSuffix(saleFee)}
          </p>
        ) : null}

        {/* The same fraction the buyer sees, from the same `deriveStatus` the
            pills below use, so the bar can never disagree with the badges. */}
        <ProgressBar
          className="mt-4"
          value={paidEntries}
          total={sale.scheduleEntries.length}
          noun="paid"
        />
      </Card>

      {/* The unit itself, so an agent on the phone about an arrears call is
          looking at the same plan and renders the buyer has in front of them. */}
      <Card className="mb-6">
        <UnitImagery
          unitName={sale.unit.name}
          projectName={sale.project.name}
          layoutImageUrl={sale.unit.layoutImageUrl}
          renderImageUrls={sale.unit.renderImageUrls}
          heading={`Unit ${sale.unit.name}`}
        />
      </Card>

      <h2 className="mb-2 mt-6 text-base font-semibold text-navy-900">Record a payment</h2>
      <Card className="mb-6">
        <PaymentForm saleId={sale.id} currency={sale.currency} entries={payableEntries} />
      </Card>

      <h2 className="mb-2 mt-6 text-base font-semibold text-navy-900">Payment schedule</h2>
      <Card className="p-0">
        <ul className="divide-y divide-line">
          {sale.scheduleEntries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
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
                  saleId={sale.id}
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
          <p className="text-[15px] text-muted">No payments recorded yet.</p>
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
                  {payment.voidedAt ? (
                    <p className="text-[13px] text-status-overdue-text">
                      Voided{payment.voidReason ? `: ${payment.voidReason}` : ''}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  {/* A voided payment keeps its row and says so in the overdue
                      red, matching the buyer's copy of the same history. */}
                  {payment.voidedAt ? <StatusPill status="OVERDUE">Voided</StatusPill> : null}
                  {payment.document ? (
                    <Link
                      href={`/api/documents/${payment.document.id}`}
                      className="inline-flex min-h-11 items-center text-sm font-semibold text-navy-900 underline"
                    >
                      Receipt
                    </Link>
                  ) : null}
                  {/* Rendered for an already-voided payment too, so the
                      confirmation of a void survives the revalidation the void
                      itself triggers — see VoidControl. */}
                  {actor.role === 'ADMIN' ? (
                    <VoidControl
                      saleId={sale.id}
                      paymentId={payment.id}
                      voided={Boolean(payment.voidedAt)}
                    />
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
