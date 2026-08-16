import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireStaff } from '@/server/session'
import { prisma } from '@/server/db'
import {
  FeeOverrideSchema,
  PlanSelectionSchema,
  previewSchedule,
  projectFeeConfig
} from '@/server/services/sales'
import {
  NO_INSTALLMENT_FEE,
  bpsToPercentString,
  installmentFeeLabel,
  scheduleEntryLabel,
  type InstallmentFeeConfig
} from '@/domain/schedule'
import { formatMinor, toMinor } from '@/domain/currency'
import { ButtonLink, Card, ErrorText, PageHeader } from '@/components/ui'
import { indicativeUsdLine } from '@/components/indicative-usd'
import { UnitImagery } from '@/components/media'
import { ConfirmForm } from './ConfirmForm'

// This page's form submits to createStaffSaleAction, which writes the sale, its
// schedule and a statement document — a payment-adjacent ledger write, so it
// gets the 30s budget rather than the default.
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
    <>
      <PageHeader title={title} />
      <Card>
        <ErrorText>{message}</ErrorText>
        <ButtonLink href={backHref} variant="secondary" className="mt-4 w-full sm:w-auto">
          Back to the sale form
        </ButtonLink>
      </Card>
    </>
  )
}

/**
 * Step 2: every naira the buyer is about to commit to, computed by the same
 * pure `previewSchedule` that `createSale` persists with, so nothing shown here
 * can drift from what is written on Confirm.
 *
 * The installment charge gets its own line whenever there is one. That is the
 * fee-consent surface: a buyer signing a marked-up plan must be able to see
 * that the total exceeds the price, by how much, and at what rate — not
 * discover it by adding up 36 rows.
 */
export default async function ConfirmSalePage({
  params,
  searchParams
}: {
  params: { id: string; unitId: string }
  searchParams: Record<string, string | string[] | undefined>
}) {
  const actor = await requireStaff()
  const backHref = `/projects/${params.id}/sell/${params.unitId}`

  const parsedPlan = PlanSelectionSchema.safeParse({ ...searchParams, unitId: params.unitId })
  if (!parsedPlan.success) {
    return (
      <ProblemCard
        title="Confirm the sale"
        message={parsedPlan.error.issues[0]?.message ?? 'That payment plan is not valid.'}
        backHref={backHref}
      />
    )
  }
  const plan = parsedPlan.data

  const parsedFee = FeeOverrideSchema.safeParse({
    feeMode: searchParams.feeMode,
    markupBps: searchParams.markupBps,
    fixedFeeMinor: searchParams.fixedFeeMinor
  })
  if (!parsedFee.success) {
    return (
      <ProblemCard
        title="Confirm the sale"
        message="That installment charge is not valid."
        backHref={backHref}
      />
    )
  }
  // Undefined, not zero, when the agent left the field alone — that is what
  // tells this page to quote the project's own charge.
  const feeOverride = parsedFee.data

  // Re-fetched, never trusted from the query string: availability may have
  // changed since step 1, and the price and currency must come from the
  // database rather than from anything a browser sent.
  const unit = await prisma.unit.findFirst({
    where: { id: params.unitId, projectId: params.id, project: { orgId: actor.orgId } },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          currency: true,
          installmentFeeMode: true,
          installmentMarkupBps: true,
          installmentFixedFeeMinor: true
        }
      }
    }
  })
  if (!unit) notFound()

  if (unit.status !== 'AVAILABLE') {
    return (
      <ProblemCard
        title={unit.project.name}
        message={`Unit ${unit.name} was just taken by someone else.`}
        backHref={`/projects/${unit.project.id}`}
      />
    )
  }

  // Org-scoped, exactly as createSale will scope it.
  const buyer = await prisma.buyer.findFirst({
    where: { id: String(searchParams.buyerId ?? ''), orgId: actor.orgId },
    select: { id: true, fullName: true, phone: true, email: true }
  })
  if (!buyer) {
    return (
      <ProblemCard
        title="Confirm the sale"
        message="That buyer could not be found."
        backHref={backHref}
      />
    )
  }

  const currency = unit.project.currency

  // The same resolution createSale performs: the override when staff set one,
  // the project default otherwise, and no charge at all for a full payment
  // because nothing is financed. Resolved here so the figures quoted are the
  // figures written.
  const fee: InstallmentFeeConfig =
    plan.planType === 'INSTALLMENTS'
      ? feeOverride ?? projectFeeConfig(unit.project)
      : NO_INSTALLMENT_FEE

  let depositMinor: bigint
  let preview: ReturnType<typeof previewSchedule>
  try {
    depositMinor = toMinor(plan.deposit, currency)
    preview = previewSchedule({
      planType: plan.planType,
      priceMinor: unit.priceMinor,
      depositMinor,
      fee,
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
    label: scheduleEntryLabel(entry.sequence),
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

  // The price only, never the total and never the monthly: this line is a rough
  // sense of scale for one figure, not a second column of the contract.
  const indicativeUsd = indicativeUsdLine(unit.priceMinor, currency)

  return (
    <>
      <PageHeader
        title="Confirm the sale"
        subtitle={`${buyer.fullName} · unit ${unit.name} · ${unit.project.name}`}
      />

      {/* The same block as step 1, at the point of commitment. A buyer about to
          sign should be looking at what they are signing for, not only at the
          money — and if there is no plan on file, the placeholder says so
          before they commit rather than after. */}
      <Card className="mb-4">
        <UnitImagery
          unitId={unit.id}
          unitName={unit.name}
          projectName={unit.project.name}
          layoutImageUrl={unit.layoutImageUrl}
          renderImageUrls={unit.renderImageUrls}
          heading="What you are buying"
        />
      </Card>

      <Card className="mb-4">
        <dl className="grid grid-cols-2 gap-y-2 text-[15px]">
          <dt className="text-[13px] text-muted">Buyer</dt>
          <dd className="text-right font-semibold text-ink">
            {buyer.fullName}
            <span className="block text-[13px] font-normal text-muted">{buyer.phone}</span>
          </dd>

          <dt className="text-[13px] text-muted">Unit</dt>
          <dd className="text-right font-semibold text-ink">{unit.name}</dd>

          <dt className="text-[13px] text-muted">Price</dt>
          <dd className="text-right font-semibold tabular-nums text-ink">
            {formatMinor(unit.priceMinor, currency)}
            {/* The mockup's rough dollar equivalent, at the point of commitment.
                Presentational only: the figure signed below is the naira one,
                and `@/components/indicative-usd` is unreachable from anything
                that prices this sale. */}
            {indicativeUsd ? (
              <span className="block text-[13px] font-normal tabular-nums text-muted">
                {indicativeUsd}
              </span>
            ) : null}
          </dd>

          {depositMinor > 0n ? (
            <>
              <dt className="text-[13px] text-muted">Deposit</dt>
              <dd className="text-right font-semibold tabular-nums text-ink">
                {formatMinor(depositMinor, currency)}
                <span className="block text-[13px] font-normal text-muted">due at signing</span>
              </dd>
            </>
          ) : null}

          {preview.feeMinor > 0n ? (
            <>
              <dt className="text-[13px] text-muted">{installmentFeeLabel(fee)}</dt>
              <dd className="text-right font-semibold tabular-nums text-ink">
                +{formatMinor(preview.feeMinor, currency)}
              </dd>
            </>
          ) : null}

          {plan.planType === 'INSTALLMENTS' ? (
            <>
              <dt className="text-[13px] text-muted">Term</dt>
              <dd className="text-right font-semibold tabular-nums text-ink">
                {plan.termMonths} months
              </dd>
            </>
          ) : null}

          {preview.monthlyMinor !== null ? (
            <>
              <dt className="text-[13px] text-muted">Monthly</dt>
              <dd className="text-right font-semibold tabular-nums text-ink">
                {formatMinor(preview.monthlyMinor, currency)}
              </dd>
            </>
          ) : null}

          {finalLabel ? (
            <>
              <dt className="text-[13px] text-muted">Final installment</dt>
              <dd className="text-right font-semibold tabular-nums text-ink">{finalLabel}</dd>
            </>
          ) : null}

          <dt className="font-semibold text-navy-900">Total owed</dt>
          <dd className="text-right font-bold tabular-nums text-navy-900">
            {formatMinor(preview.totalMinor, currency)}
          </dd>

          <dt className="text-[13px] text-muted">First payment due</dt>
          <dd className="text-right font-semibold tabular-nums text-ink">{firstDue}</dd>

          <dt className="text-[13px] text-muted">Last payment due</dt>
          <dd className="text-right font-semibold tabular-nums text-ink">{lastDue}</dd>
        </dl>
      </Card>

      {/* The fee-consent sentence, and the one place the two modes need real
          prose rather than a label. A percentage is explained as a rate on the
          financed amount; a flat fee is explained as exactly that, with no
          percentage anywhere in it — a developer choosing FIXED is doing so
          because a rate on the financed amount is not permissible in their
          market, and reading them one from this page would defeat it. */}
      {preview.feeMinor > 0n ? (
        <p className="mb-4 text-[13px] text-muted">
          {fee.mode === 'PERCENT' ? (
            // Inside this branch the rate is real, so quoting it is correct —
            // it is the FIXED branch below that must never see a percentage.
            <>
              The installment charge of {formatMinor(preview.feeMinor, currency)} is{' '}
              {bpsToPercentString(fee.bps)}% of the financed{' '}
              {formatMinor(unit.priceMinor - depositMinor, currency)}.
            </>
          ) : (
            <>
              The installment charge is a flat {formatMinor(preview.feeMinor, currency)} — not a
              percentage, and the same amount whatever is financed.
            </>
          )}{' '}
          It is spread across the monthly installments
          {depositMinor > 0n ? '; the deposit itself is not charged' : ''}. Read this to the buyer
          before they sign.
        </p>
      ) : null}

      {finalLabel ? (
        <p className="mb-4 text-[13px] text-muted">
          The last payment is {finalLabel} because the monthly figure is rounded down to the
          nearest minor unit.
        </p>
      ) : null}

      <Card className="mb-4">
        <h2 className="mb-3 text-base font-semibold text-navy-900">Full payment schedule</h2>
        {/* The table scrolls inside this box rather than pushing the page
            sideways — 375px is the floor, and three columns of money fit it. */}
        <div className="overflow-x-auto">
          <table className="w-full text-[15px]">
            <thead>
              <tr className="border-b border-line text-left text-[13px] font-medium text-muted">
                <th className="w-20 py-1.5">#</th>
                <th className="py-1.5">Due date</th>
                <th className="py-1.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.sequence} className="border-b border-line last:border-0">
                  <td className="py-1.5 text-ink">{row.label}</td>
                  <td className="py-1.5 tabular-nums text-muted">{row.dueDate}</td>
                  <td className="py-1.5 text-right font-semibold tabular-nums text-ink">
                    {row.amount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <ConfirmForm
        unitId={unit.id}
        buyerId={buyer.id}
        planType={plan.planType}
        deposit={plan.deposit}
        termMonths={plan.termMonths}
        // The override as it was priced above, or nulls meaning "the project
        // default". Minor units cross as a string: a bigint may not enter a
        // client component, and this one has already been parsed against the
        // project's currency, so it must not be re-parsed as a decimal.
        feeMode={feeOverride?.mode ?? null}
        markupBps={feeOverride?.mode === 'PERCENT' ? feeOverride.bps : null}
        fixedFeeMinor={
          feeOverride?.mode === 'FIXED' ? feeOverride.fixedMinor.toString() : null
        }
      />

      <div className="mt-3 flex justify-center">
        <Link
          href={backHref}
          className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-muted underline"
        >
          Back
        </Link>
      </div>
    </>
  )
}
