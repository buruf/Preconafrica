import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireStaff } from '@/server/session'
import { prisma } from '@/server/db'
import { DEFAULT_TERM_MONTHS, listBuyers } from '@/server/services/sales'
import { bpsToPercentString } from '@/domain/schedule'
import { formatMinor } from '@/domain/currency'
import { Card, PageHeader } from '@/components/ui'
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
      project: { select: { id: true, name: true, currency: true, installmentMarkupBps: true } }
    }
  })
  if (!unit) notFound()

  const backHref = `/projects/${unit.project.id}`

  if (unit.status !== 'AVAILABLE') {
    return (
      <>
        <PageHeader title={`Unit ${unit.name}`} subtitle={unit.project.name} />
        <Card>
          <p className="text-sm text-slate-700">
            Unit {unit.name} is no longer available — it is marked{' '}
            {unit.status.toLowerCase()}.
          </p>
          <p className="mt-3 text-sm">
            <Link href={backHref} className="font-medium underline">
              Back to the inventory
            </Link>
          </p>
        </Card>
      </>
    )
  }

  const buyers = await listBuyers(actor)

  return (
    <>
      <PageHeader
        title={`Sell unit ${unit.name}`}
        subtitle={`${unit.project.name} · ${unit.bedrooms} bed · ${unit.sizeSqm.toString()} m²`}
        action={
          <span className="text-lg font-semibold">
            {/* BigInt never crosses the RSC boundary — formatted on the server. */}
            {formatMinor(unit.priceMinor, unit.project.currency)}
          </span>
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
        defaultMarkupPercent={bpsToPercentString(unit.project.installmentMarkupBps)}
      />

      <p className="mt-3 text-center text-sm">
        <Link href={backHref} className="underline">
          Back to the inventory
        </Link>
      </p>
    </>
  )
}
