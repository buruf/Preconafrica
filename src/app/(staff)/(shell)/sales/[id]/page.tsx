import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireStaff } from '@/server/session'
import { getSaleForStaff, summariseSale } from '@/server/services/sales'
import { ServiceError } from '@/server/services/errors'
import { deriveStatus } from '@/domain/status'
import { bpsToPercentString, computeMarkupMinor, scheduleEntryLabel } from '@/domain/schedule'
import { formatMinor } from '@/domain/currency'
import { Card, PageHeader } from '@/components/ui'
import { StatusBadge } from '@/components/StatusBadge'
import { PaymentForm } from './PaymentForm'
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

  // Recomputed from the sale's own snapshot — priceMinor, depositMinor and
  // markupBps were all frozen at signing — rather than inferred by subtracting
  // the price from the schedule total, so the line stays right even if a row
  // were ever hand-repaired. Without it, a marked-up sale simply reads as owing
  // more than the unit cost, with nothing on the page explaining why.
  const markupMinor =
    sale.markupBps > 0
      ? computeMarkupMinor(sale.priceMinor - sale.depositMinor, sale.markupBps)
      : 0n

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
            className="flex min-h-11 items-center text-sm font-medium underline"
          >
            {sale.buyer.phone}
          </a>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <p className="text-xs text-slate-500">Total owed</p>
          <p className="text-lg font-semibold">{money(summary.totalOwedMinor)}</p>
          {markupMinor > 0n ? (
            <p className="mt-1 text-xs text-slate-500">
              includes {money(markupMinor)} installment charge (
              {bpsToPercentString(sale.markupBps)}%)
            </p>
          ) : null}
        </Card>
        <Card>
          <p className="text-xs text-slate-500">Paid to date</p>
          <p className="text-lg font-semibold text-emerald-700">{money(summary.paidToDateMinor)}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">Balance</p>
          <p className="text-lg font-semibold">{money(summary.balanceMinor)}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">Next payment due</p>
          {summary.nextDue ? (
            <p className="text-lg font-semibold">
              {money(summary.nextDue.amountMinor)}{' '}
              <span className="text-sm font-normal text-slate-500">
                on {date(summary.nextDue.dueDate)}
              </span>
            </p>
          ) : (
            <p className="text-lg font-semibold text-emerald-700">Fully paid</p>
          )}
          {summary.overdueCount > 0 ? (
            <p className="mt-1 text-sm text-rose-700">
              {summary.overdueCount} payment{summary.overdueCount === 1 ? '' : 's'} overdue
            </p>
          ) : null}
        </Card>
      </div>

      <h2 className="mb-2 mt-6 font-semibold">Record a payment</h2>
      <Card className="mb-6">
        <PaymentForm saleId={sale.id} />
      </Card>

      <h2 className="mb-2 mt-6 font-semibold">Payment schedule</h2>
      <Card className="p-0">
        <ul className="divide-y divide-slate-100">
          {sale.scheduleEntries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {scheduleEntryLabel(entry.sequence)} · {date(entry.dueDate)}
                </p>
                <p className="text-xs text-slate-500">
                  {money(entry.amountPaidMinor)} of {money(entry.amountDueMinor)} paid
                </p>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge status={deriveStatus(entry, asOf)} />
                <InvoiceControl
                  saleId={sale.id}
                  scheduleEntryId={entry.id}
                  documentId={invoiceByEntryId.get(entry.id) ?? null}
                  // Compared here, on the server: the client component gets a
                  // boolean, never the bigint.
                  hasPayment={entry.amountPaidMinor > 0n}
                />
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <h2 className="mb-2 mt-6 font-semibold">Payment history</h2>
      {sale.payments.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">No payments recorded yet.</p>
        </Card>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-slate-100">
            {sale.payments.map((payment) => (
              <li key={payment.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p
                    className={`text-sm font-medium ${
                      payment.voidedAt ? 'text-slate-400 line-through' : ''
                    }`}
                  >
                    {money(payment.amountMinor)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {date(payment.receivedAt)} · {payment.method.replace(/_/g, ' ').toLowerCase()}
                    {payment.reference ? ` · ${payment.reference}` : ''}
                  </p>
                  {payment.voidedAt ? (
                    <p className="text-xs text-rose-700">
                      Voided{payment.voidReason ? `: ${payment.voidReason}` : ''}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  {payment.document ? (
                    <Link
                      href={`/api/documents/${payment.document.id}`}
                      className="inline-flex min-h-11 items-center text-sm underline"
                    >
                      Receipt
                    </Link>
                  ) : null}
                  {actor.role === 'ADMIN' && !payment.voidedAt ? (
                    <VoidControl saleId={sale.id} paymentId={payment.id} />
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
