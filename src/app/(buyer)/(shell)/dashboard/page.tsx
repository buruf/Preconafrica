import Link from 'next/link'
import { requireBuyer } from '@/server/session'
import { getSaleForBuyer, summariseSale } from '@/server/services/sales'
import { deriveStatus } from '@/domain/status'
import { formatMinor } from '@/domain/currency'
import { Card, PageHeader } from '@/components/ui'
import { StatusBadge } from '@/components/StatusBadge'

const date = (d: Date) => d.toISOString().slice(0, 10)

export default async function BuyerDashboard() {
  const actor = await requireBuyer()
  const sale = await getSaleForBuyer(actor)

  if (!sale) {
    return (
      <Card>
        <p className="text-sm text-slate-500">You do not have a unit yet.</p>
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

  return (
    <>
      <PageHeader
        title={`Unit ${sale.unit.name}`}
        subtitle={`${sale.project.name} · ${sale.project.location}`}
      />

      <div className="mb-5 grid grid-cols-2 gap-3">
        <Card>
          <p className="text-xs text-slate-500">Paid to date</p>
          <p className="text-lg font-semibold text-emerald-700">{money(summary.paidToDateMinor)}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">Balance</p>
          <p className="text-lg font-semibold">{money(summary.balanceMinor)}</p>
        </Card>
        <Card className="col-span-2">
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

      {statement ? (
        <Link
          href={`/api/documents/${statement.id}`}
          className="mb-5 inline-flex min-h-11 items-center text-sm font-medium underline"
        >
          Download my payment statement (PDF)
        </Link>
      ) : null}

      <h2 className="mb-2 mt-6 font-semibold">Payment schedule</h2>
      <Card className="p-0">
        <ul className="divide-y divide-slate-100">
          {sale.scheduleEntries.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 p-3">
              <div>
                <p className="text-sm font-medium">
                  {entry.sequence}. {date(entry.dueDate)}
                </p>
                <p className="text-xs text-slate-500">
                  {money(entry.amountPaidMinor)} of {money(entry.amountDueMinor)} paid
                </p>
              </div>
              <StatusBadge status={deriveStatus(entry, asOf)} />
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
              <li key={payment.id} className="flex items-center justify-between gap-3 p-3">
                <div>
                  <p className={`text-sm font-medium ${payment.voidedAt ? 'text-slate-400 line-through' : ''}`}>
                    {money(payment.amountMinor)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {date(payment.receivedAt)} · {payment.method.replace(/_/g, ' ').toLowerCase()}
                    {payment.reference ? ` · ${payment.reference}` : ''}
                  </p>
                  {payment.voidedAt ? <p className="text-xs text-rose-700">Voided</p> : null}
                </div>
                {payment.document ? (
                  <Link
                    href={`/api/documents/${payment.document.id}`}
                    className="inline-flex min-h-11 items-center text-sm underline"
                  >
                    Receipt
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}
