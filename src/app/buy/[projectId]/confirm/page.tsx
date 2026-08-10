import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/server/session'
import { prisma } from '@/server/db'
import { PlanSelectionSchema, previewSchedule } from '@/server/services/sales'
import { toMinor, formatMinor } from '@/domain/currency'
import { Card, ErrorText, PageHeader } from '@/components/ui'
import { ConfirmForm } from './ConfirmForm'

// This page's form submits to createSaleAction, which writes the sale and
// its schedule — a payment-adjacent ledger write, so it gets the 30s budget.
export const maxDuration = 30

function ProblemCard({
  title,
  message,
  backHref
}: {
  title: string
  message: string
  backHref: string
}) {
  return (
    <main className="mx-auto max-w-xl p-4 sm:p-6">
      <PageHeader title={title} />
      <Card>
        <ErrorText>{message}</ErrorText>
        <p className="mt-3 text-sm">
          <Link href={backHref} className="font-medium underline">
            Back to unit selection
          </Link>
        </p>
      </Card>
    </main>
  )
}

/**
 * The whole point of this screen: every installment the buyer is about to
 * sign up for, computed by the same pure previewSchedule() that createSale()
 * uses to persist them, so nothing shown here can drift from what gets
 * written to the database on Confirm.
 */
export default async function ConfirmPage({
  params,
  searchParams
}: {
  params: { projectId: string }
  searchParams: Record<string, string | string[] | undefined>
}) {
  const actor = await requireUser()
  const backHref = `/buy/${params.projectId}`

  const parsedPlan = PlanSelectionSchema.safeParse(searchParams)
  if (!parsedPlan.success) {
    return (
      <ProblemCard
        title="Confirm your purchase"
        message="Please choose a unit and a plan."
        backHref={backHref}
      />
    )
  }
  const plan = parsedPlan.data

  // Re-fetched, not trusted from the query string: availability may have
  // changed since step 1, and the price/currency must come from the
  // database, not from anything the buyer's browser sent.
  const unit = await prisma.unit.findFirst({
    where: { id: plan.unitId, projectId: params.projectId, project: { orgId: actor.orgId } },
    include: { project: { select: { id: true, name: true, currency: true } } }
  })
  if (!unit) notFound()

  if (unit.status !== 'AVAILABLE') {
    return (
      <ProblemCard
        title={unit.project.name}
        message="That unit was just taken by someone else."
        backHref={backHref}
      />
    )
  }

  const currency = unit.project.currency

  let depositMinor: bigint
  let preview: ReturnType<typeof previewSchedule>
  try {
    depositMinor = toMinor(plan.deposit, currency)
    preview = previewSchedule({
      planType: plan.planType,
      priceMinor: unit.priceMinor,
      depositMinor,
      months: plan.termMonths,
      signedAt: new Date()
    })
  } catch (error) {
    return (
      <ProblemCard
        title={unit.project.name}
        message={error instanceof Error ? error.message : 'That payment plan is not valid.'}
        backHref={backHref}
      />
    )
  }

  const rows = preview.entries.map((entry) => ({
    sequence: entry.sequence,
    dueDate: entry.dueDate.toISOString().slice(0, 10),
    amount: formatMinor(entry.amountDueMinor, currency)
  }))
  const firstDue = rows[0]?.dueDate
  const lastDue = rows[rows.length - 1]?.dueDate

  const finalDiffers =
    preview.monthlyMinor !== null &&
    preview.finalMinor !== null &&
    preview.finalMinor !== preview.monthlyMinor
  const finalLabel = finalDiffers ? formatMinor(preview.finalMinor as bigint, currency) : null

  return (
    <main className="mx-auto max-w-xl p-4 sm:p-6">
      <PageHeader title="Confirm your purchase" subtitle={unit.project.name} />

      <Card className="mb-4">
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-slate-500">Unit</dt>
          <dd className="text-right font-medium">{unit.name}</dd>

          <dt className="text-slate-500">Price</dt>
          <dd className="text-right font-medium">{formatMinor(unit.priceMinor, currency)}</dd>

          <dt className="text-slate-500">Deposit</dt>
          <dd className="text-right font-medium">{formatMinor(depositMinor, currency)}</dd>

          {preview.monthlyMinor !== null ? (
            <>
              <dt className="text-slate-500">Monthly</dt>
              <dd className="text-right font-medium">
                {formatMinor(preview.monthlyMinor, currency)}
              </dd>
            </>
          ) : null}

          {finalLabel ? (
            <>
              <dt className="text-slate-500">Final installment</dt>
              <dd className="text-right font-medium">{finalLabel}</dd>
            </>
          ) : null}

          {plan.planType === 'INSTALLMENTS' ? (
            <>
              <dt className="text-slate-500">Term</dt>
              <dd className="text-right font-medium">{plan.termMonths} months</dd>
            </>
          ) : null}

          <dt className="text-slate-500">Total</dt>
          <dd className="text-right font-medium">{formatMinor(preview.totalMinor, currency)}</dd>

          <dt className="text-slate-500">First payment due</dt>
          <dd className="text-right font-medium">{firstDue}</dd>

          <dt className="text-slate-500">Last payment due</dt>
          <dd className="text-right font-medium">{lastDue}</dd>
        </dl>
      </Card>

      {finalLabel ? (
        <p className="mb-4 text-xs text-slate-500">
          Your last payment is {finalLabel} because the monthly figure is rounded down to the
          nearest minor unit.
        </p>
      ) : null}

      <Card className="mb-4">
        <h2 className="mb-3 font-semibold">Full payment schedule</h2>
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="w-8 py-1">#</th>
                <th className="py-1">Due date</th>
                <th className="py-1 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.sequence} className="border-b border-slate-100 last:border-0">
                  <td className="py-1">{row.sequence}</td>
                  <td className="py-1">{row.dueDate}</td>
                  <td className="py-1 text-right">{row.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <ConfirmForm
        unitId={unit.id}
        planType={plan.planType}
        deposit={plan.deposit}
        termMonths={plan.termMonths}
      />

      <p className="mt-3 text-center text-sm">
        <Link href={backHref} className="underline">
          Back
        </Link>
      </p>
    </main>
  )
}
