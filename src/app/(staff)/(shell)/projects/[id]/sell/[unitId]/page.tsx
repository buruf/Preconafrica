import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireStaff } from '@/server/session'
import { prisma } from '@/server/db'
import { DEFAULT_TERM_MONTHS, listBuyers } from '@/server/services/sales'
import { bpsToPercentString } from '@/domain/schedule'
import { formatMinor, toMajorString } from '@/domain/currency'
import { ButtonLink, Card, PageHeader } from '@/components/ui'
import { indicativeUsdLine } from '@/components/indicative-usd'
import { UnitImagery } from '@/components/media'
import { SellForm } from './SellForm'

/**
 * Step 1 of the staff sale. Staff sell and buyers view: the developer's agent
 * registers the buyer, picks the plan and signs the deal, and the buyer's login
 * is a read-only dashboard afterwards. There is no public purchase page.
 *
 * `requireStaff()` covers both roles deliberately — an agent selling units is
 * the entire job description. `createSale` re-authorizes on the write anyway.
 */
export default async function SellUnitPage({
  params
}: {
  params: { id: string; unitId: string }
}) {
  const actor = await requireStaff()

  // Org-scoped and project-scoped: a unit id from another organisation, or one
  // that belongs to a different project than the URL claims, is a routing miss
  // rather than an error page.
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

  const backHref = `/projects/${unit.project.id}`

  if (unit.status !== 'AVAILABLE') {
    return (
      <>
        <PageHeader title={`Unit ${unit.name}`} subtitle={unit.project.name} />
        <Card>
          <p className="text-[15px] text-ink">
            Unit {unit.name} is no longer available — it is marked{' '}
            {unit.status.toLowerCase()}.
          </p>
          <ButtonLink href={backHref} variant="secondary" className="mt-4 w-full sm:w-auto">
            Back to the inventory
          </ButtonLink>
        </Card>
      </>
    )
  }

  const buyers = await listBuyers(actor)
  const indicativeUsd = indicativeUsdLine(unit.priceMinor, unit.project.currency)

  return (
    <>
      <PageHeader
        title={`Sell unit ${unit.name}`}
        subtitle={`${unit.project.name} · ${unit.bedrooms} bed · ${unit.sizeSqm.toString()} m²`}
        action={
          <div className="text-right">
            <p className="text-[22px] font-bold leading-tight tabular-nums text-navy-900">
              {/* BigInt never crosses the RSC boundary — formatted on the server. */}
              {formatMinor(unit.priceMinor, unit.project.currency)}
            </p>
            {/* Approximate, labelled, and read by nothing that prices this sale
                — see `@/components/indicative-usd`. */}
            {indicativeUsd ? (
              <p className="text-[13px] tabular-nums text-muted">{indicativeUsd}</p>
            ) : null}
          </div>
        }
      />

      {/* Before the form, not after it: an agent sells this unit with the buyer
          beside them, and the plan and renders are what the conversation is
          about. */}
      <Card className="mb-5">
        <UnitImagery
          unitName={unit.name}
          projectName={unit.project.name}
          layoutImageUrl={unit.layoutImageUrl}
          renderImageUrls={unit.renderImageUrls}
        />
      </Card>

      <SellForm
        projectId={unit.project.id}
        unitId={unit.id}
        buyers={buyers}
        defaultTermMonths={DEFAULT_TERM_MONTHS}
        currency={unit.project.currency}
        // Both prefills cross as strings, never as a bigint — nothing of that
        // type may reach a client component. `toMajorString` round-trips
        // exactly back through `toMinor`, so an agent who opens the form and
        // submits it unchanged re-signs the project's own figure to the minor
        // unit rather than a rounded version of it.
        defaultFeeMode={unit.project.installmentFeeMode}
        defaultMarkupPercent={bpsToPercentString(unit.project.installmentMarkupBps)}
        defaultFixedFee={toMajorString(
          unit.project.installmentFixedFeeMinor,
          unit.project.currency
        )}
      />

      {/* 44px, centred, and a link rather than a button: it navigates, and it is
          the secondary way off this screen. */}
      <div className="mt-3 flex justify-center">
        <Link
          href={backHref}
          className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-muted underline"
        >
          Back to the inventory
        </Link>
      </div>
    </>
  )
}
