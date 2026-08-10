import { requireStaff } from '@/server/session'
import { getProjectInventory } from '@/server/services/units'
import { exponentFor, formatMinor } from '@/domain/currency'
import { Card, PageHeader } from '@/components/ui'
import { UnitRow } from './UnitRow'

const TONE = {
  AVAILABLE: 'bg-emerald-100 text-emerald-800',
  RESERVED: 'bg-amber-100 text-amber-800',
  SOLD: 'bg-slate-200 text-slate-600'
} as const

export default async function ProjectPage({ params }: { params: { id: string } }) {
  const actor = await requireStaff()
  const { project, floors, totals } = await getProjectInventory(actor, params.id)

  return (
    <>
      <PageHeader title={project.name} subtitle={project.location} />

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
                    // BigInt is not serializable across the RSC boundary, so
                    // formatting happens here on the server.
                    priceLabel: formatMinor(unit.priceMinor, project.currency),
                    // Exponent-aware: dividing by 100n would be wrong for RWF.
                    priceInput: (
                      unit.priceMinor / 10n ** BigInt(exponentFor(project.currency))
                    ).toString()
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
