import Link from 'next/link'
import { requireStaff } from '@/server/session'
import { arrearsReport } from '@/server/services/arrears'
import { formatMinor } from '@/domain/currency'
import { Card, PageHeader } from '@/components/ui'

export default async function ArrearsPage() {
  const actor = await requireStaff()
  const asOf = new Date()
  const rows = await arrearsReport(actor, asOf)

  const total = rows.length

  return (
    <>
      <PageHeader
        title="Arrears"
        subtitle={
          total === 0
            ? 'No buyers are currently overdue.'
            : `${total} buyer${total === 1 ? '' : 's'} overdue as of ${asOf.toISOString().slice(0, 10)}`
        }
      />

      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.saleId}>
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/sales/${row.saleId}`} className="font-medium underline">
                    {row.buyerName}
                  </Link>
                  <p className="text-sm text-slate-500">
                    {row.projectName} · Unit {row.unitName}
                  </p>
                  <a href={`tel:${row.buyerPhone}`} className="text-sm text-slate-700 underline">
                    {row.buyerPhone}
                  </a>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-rose-700">
                    {formatMinor(row.overdueAmountMinor, row.currency)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {row.overdueCount} installment{row.overdueCount === 1 ? '' : 's'}
                  </p>
                  <p className="text-xs text-rose-700">{row.daysLate} days late</p>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  )
}
