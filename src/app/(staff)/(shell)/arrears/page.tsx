import Link from 'next/link'
import { requireStaff } from '@/server/session'
import { arrearsReport } from '@/server/services/arrears'
import { listProjects } from '@/server/services/projects'
import { formatMinor } from '@/domain/currency'
import {
  Button,
  ButtonLink,
  Card,
  Field,
  PageHeader,
  Select,
  StatCard,
  StatusPill
} from '@/components/ui'

/**
 * The developer's arrears report, brought up to the mockup.
 *
 * Three things it did not have and now does — stat cards, a project filter and a
 * CSV export — plus the row treatment from DESIGN.md. What it deliberately keeps
 * is the service's ordering: `arrearsReport` returns worst-first (longest
 * overdue at the top) and this page does not re-sort, because the first row is
 * the call an agent should make first.
 *
 * ## Why the money totals are per currency
 *
 * This organisation sells in NGN and in KES. Adding those two together produces
 * a number that is not money in any currency and cannot be spent, budgeted or
 * chased — so there is deliberately no single "Total Overdue" figure. There is
 * one card per currency actually present in the report, each labelled with its
 * code, and they appear only when there is something in them. An org selling in
 * one currency therefore sees exactly one total, which is the mockup; an org
 * selling in two sees two, which is the truth.
 *
 * The buyer count is separate and currency-free, and it counts distinct *buyers*
 * rather than rows: a row is one contract, and one buyer can hold two.
 *
 * Server-rendered end to end — the filter is a plain GET form, so the filtered
 * view is a shareable URL and there is no client component on this screen at
 * all. Every amount passes through `formatMinor` here.
 */

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

export default async function ArrearsPage({
  searchParams
}: {
  searchParams?: { project?: string | string[] }
}) {
  const actor = await requireStaff()
  const asOf = new Date()
  const selectedProjectId = firstParam(searchParams?.project)

  // Independent reads, issued together: the filter's options do not depend on
  // the report and the page should cost one round trip's latency, not two.
  const [projects, rows] = await Promise.all([
    listProjects(actor),
    arrearsReport(actor, asOf, { projectId: selectedProjectId || undefined })
  ])

  // Summed per currency, in bigint, from the same rows the list below renders —
  // so the figure at the top of the screen is the sum of the figures under it by
  // construction rather than by a second query that could drift.
  const overdueByCurrency = new Map<string, { amountMinor: bigint; buyerIds: Set<string> }>()
  for (const row of rows) {
    const bucket = overdueByCurrency.get(row.currency) ?? {
      amountMinor: 0n,
      buyerIds: new Set<string>()
    }
    bucket.amountMinor += row.overdueAmountMinor
    bucket.buyerIds.add(row.buyerId)
    overdueByCurrency.set(row.currency, bucket)
  }
  // Sorted by code, not by amount: two currencies cannot be compared by size,
  // and a card order that changed as payments came in would be disorienting.
  const currencies = [...overdueByCurrency.keys()].sort()

  const buyerCount = new Set(rows.map((row) => row.buyerId)).size
  const asOfLabel = asOf.toISOString().slice(0, 10)

  // Carried onto the export so the download matches the screen. Built from the
  // validated selection rather than from the raw query string, so nothing else a
  // browser sent rides along into the route handler's URL.
  const exportHref = selectedProjectId
    ? `/arrears/export?project=${encodeURIComponent(selectedProjectId)}`
    : '/arrears/export'

  return (
    <>
      <PageHeader
        title="Arrears"
        subtitle={`Overdue as of ${asOfLabel}${
          selectedProjectId ? '' : ' · every project'
        }`}
        action={
          // A plain <a>, not a Link: this is a route handler answering with
          // `Content-Disposition: attachment`, and the router must not try to
          // client-navigate to a spreadsheet or prefetch one on hover.
          <ButtonLink href={exportHref} variant="secondary" external>
            Export CSV
          </ButtonLink>
        }
      />

      {/* One card per currency present, plus the head count. Never a single
          cross-currency total — see the note at the top of this file. */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {currencies.map((currency) => {
          const bucket = overdueByCurrency.get(currency)
          if (!bucket) return null
          const buyers = bucket.buyerIds.size
          return (
            <StatCard
              key={currency}
              label={`Total overdue · ${currency}`}
              tone="bad"
              // formatMinor on the server, so no bigint leaves this file.
              value={formatMinor(bucket.amountMinor, currency)}
              sub={`${buyers} buyer${buyers === 1 ? '' : 's'}`}
            />
          )
        })}

        <StatCard
          label="Buyers overdue"
          value={String(buyerCount)}
          tone={buyerCount > 0 ? 'bad' : 'good'}
          // Contracts, not buyers, when the two differ — one buyer holding two
          // late units is one call and two balances.
          sub={
            rows.length === buyerCount
              ? `${rows.length} contract${rows.length === 1 ? '' : 's'}`
              : `across ${rows.length} contracts`
          }
        />
      </div>

      {/* A GET form, so the filtered report is a URL an admin can send to an
          agent. No JavaScript anywhere in it: the select is native (it opens the
          platform picker on a phone) and the submit is a real submit, which is
          also why there is a button rather than an onChange. */}
      <Card className="mb-5">
        <form method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Field label="Project" name="project">
              <Select name="project" defaultValue={selectedProjectId}>
                <option value="">All projects</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} ({project.currency})
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" variant="secondary" className="w-full sm:w-auto">
            Apply filter
          </Button>
        </form>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <p className="text-[15px] text-muted">
            {selectedProjectId
              ? 'No buyers are overdue on this project.'
              : 'No buyers are currently overdue.'}
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.saleId}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    {/* 44px, both of them. These were 21px and 19px — the two
                        controls an agent taps most on this screen, on a phone,
                        while reading a name off it. */}
                    <Link
                      href={`/sales/${row.saleId}`}
                      className="inline-flex min-h-11 items-center text-[15px] font-semibold text-navy-900 underline"
                    >
                      {row.buyerName}
                    </Link>
                    <p className="text-[13px] text-muted">
                      {row.projectName} · Unit {row.unitName}
                    </p>
                    <a
                      href={`tel:${row.buyerPhone}`}
                      className="inline-flex min-h-11 items-center text-[15px] font-medium tabular-nums text-navy-900 underline"
                    >
                      {row.buyerPhone}
                    </a>
                  </div>

                  <div className="text-right">
                    <p className="text-[22px] font-bold leading-tight tabular-nums text-status-overdue-text">
                      {formatMinor(row.overdueAmountMinor, row.currency)}
                    </p>
                    <p className="mt-0.5 text-[13px] tabular-nums text-muted">
                      {row.overdueCount} installment{row.overdueCount === 1 ? '' : 's'} · since{' '}
                      {row.oldestDueDate.toISOString().slice(0, 10)}
                    </p>
                    {/* The overdue triple from DESIGN.md, deliberately a
                        different red from Sold: this is money owed today, not a
                        fact about a unit. */}
                    <StatusPill status="OVERDUE" className="mt-1.5">
                      {row.daysLate} days late
                    </StatusPill>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
