import { notFound } from 'next/navigation'
import { requireStaff } from '@/server/session'
import { getProjectInventory } from '@/server/services/units'
import { ServiceError } from '@/server/services/errors'
import { installmentFeeSummary } from '@/domain/schedule'
import { projectFeeConfig } from '@/server/services/sales'
import { formatMinor, toMajorString } from '@/domain/currency'
import { Card, PageHeader } from '@/components/ui'
import { MediaImage } from '@/components/media'
import { HeroImageForm } from './HeroImageForm'
import { UnitRow } from './UnitRow'

const TONE = {
  AVAILABLE: 'bg-emerald-100 text-emerald-800',
  RESERVED: 'bg-amber-100 text-amber-800',
  SOLD: 'bg-slate-200 text-slate-600'
} as const

export default async function ProjectPage({ params }: { params: { id: string } }) {
  const actor = await requireStaff()

  // A missing or cross-org project is a clean 404, not the access-denied
  // boundary — same treatment as the staff sale page.
  let inventory
  try {
    inventory = await getProjectInventory(actor, params.id)
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'NOT_FOUND') notFound()
    throw error
  }
  const { project, floors, totals } = inventory

  return (
    <>
      <PageHeader
        title={project.name}
        // The installment charge belongs in the header because it is the figure
        // every "Sell" on this page prefills. Visible only on the sale form, a
        // project still sitting at 0% is noticed after a contract is signed at
        // 0%, not before. `installmentFeeSummary` prints '10%' or the money, and
        // never a percentage for a flat fee.
        subtitle={`${project.location} · Installment charge ${installmentFeeSummary(
          projectFeeConfig(project),
          project.currency
        )}`}
      />

      {/* The building, before the numbers. A developer's inventory page is the
          one screen an agent shows a walk-in buyer, and it opened with three
          counters and a list of unit codes. The placeholder is not a
          consolation prize either — it is how an admin discovers that the photo
          is the thing to go and set. */}
      <div className="mb-5">
        <MediaImage
          kind="building"
          src={project.heroImageUrl}
          alt={`${project.name}, ${project.location}`}
        />
        {/* ADMIN only, and the only project-edit surface in the app — see
            HeroImageForm for why it is one field rather than a settings page. */}
        {actor.role === 'ADMIN' ? (
          <HeroImageForm projectId={project.id} heroImageUrl={project.heroImageUrl} />
        ) : null}
      </div>

      <div className="mb-5 grid grid-cols-3 gap-3">
        {[
          ['Available', totals.available, 'text-emerald-700'],
          ['Reserved', totals.reserved, 'text-amber-700'],
          ['Sold', totals.sold, 'text-slate-700']
        ].map(([label, value, tone]) => (
          <Card key={label as string}>
            <p className="text-xs text-slate-500">{label as string}</p>
            <p className={`text-2xl font-semibold ${tone as string}`}>{value as number}</p>
          </Card>
        ))}
      </div>

      <div className="space-y-4">
        {floors.map((floor) => (
          <Card key={floor.floor}>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="font-semibold">Floor {floor.floor}</h2>
              <span className="text-xs text-slate-500">
                {floor.available} of {floor.total} available
              </span>
            </div>

            <ul className="divide-y divide-slate-100">
              {floor.units.map((unit) => (
                <UnitRow
                  key={unit.id}
                  projectId={project.id}
                  unit={{
                    id: unit.id,
                    name: unit.name,
                    bedrooms: unit.bedrooms,
                    sizeSqm: unit.sizeSqm,
                    status: unit.status,
                    // Non-null once a sale claims the unit: the row turns it
                    // into the link that opens that sale, which is what makes
                    // /sales/[id] reachable for a buyer who is not overdue.
                    saleId: unit.saleId,
                    // Plain strings, so they cross the RSC boundary as-is. The
                    // row shows the layout as a thumbnail; the edit form below
                    // it is where both are set.
                    layoutImageUrl: unit.layoutImageUrl,
                    renderImageUrls: unit.renderImageUrls,
                    // BigInt is not serializable across the RSC boundary, so
                    // formatting happens here on the server.
                    priceLabel: formatMinor(unit.priceMinor, project.currency),
                    // Exponent-aware and lossless: plain integer division would
                    // truncate the fractional part (₦1,000.50 -> "1000"), and
                    // resubmitting the edit form would silently reprice the
                    // unit. toMajorString keeps every minor-unit digit.
                    priceInput: toMajorString(unit.priceMinor, project.currency)
                  }}
                  tone={TONE[unit.status]}
                  editable={actor.role === 'ADMIN'}
                />
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  )
}
