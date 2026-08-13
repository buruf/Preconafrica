import { notFound } from 'next/navigation'
import { requireStaff } from '@/server/session'
import { getProjectInventory } from '@/server/services/units'
import { ServiceError } from '@/server/services/errors'
import { installmentFeeSummary } from '@/domain/schedule'
import { projectFeeConfig } from '@/server/services/sales'
import { Card, PageHeader, StatCard, StatusLegend, UnitTile } from '@/components/ui'
import { MediaImage } from '@/components/media'
import { HeroImageForm } from './HeroImageForm'

/**
 * The floor plate.
 *
 * This screen used to be a vertical list of unit rows, each carrying its own
 * price, its own status word, its own Sell link and a collapsible edit form. It
 * answered "what is unit 3B's price" well and "how much of floor 3 is left"
 * badly, which is the wrong way round for the one screen an agent turns their
 * phone round to show a walk-in buyer.
 *
 * It is now the mockup's tile grid: three units across on a phone, colour
 * carrying status, one legend, and the availability count in each floor's
 * header. Everything a row could do moved to the unit's own screen at
 * `units/[unitId]` — see that page for why a tile is a link to a detail view
 * rather than a tile with four controls crammed inside it.
 */
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
        // every "Sell" from this project prefills. Visible only on the sale form,
        // a project still sitting at 0% is noticed after a contract is signed at
        // 0%, not before. `installmentFeeSummary` prints '10%' or the money, and
        // never a percentage for a flat fee.
        subtitle={`${project.location} · Installment charge ${installmentFeeSummary(
          projectFeeConfig(project),
          project.currency
        )}`}
      />

      {/* The building, before the numbers. The placeholder is not a consolation
          prize either — it is how an admin discovers that the photo is the thing
          to go and set. */}
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
        <StatCard label="Available" value={String(totals.available)} tone="good" />
        <StatCard label="Reserved" value={String(totals.reserved)} tone="warn" />
        <StatCard label="Sold" value={String(totals.sold)} />
      </div>

      <div className="space-y-4">
        {floors.map((floor) => (
          // `details`/`summary`, not a `useState` toggle: collapsing a floor is
          // the browser's own behaviour, it works before hydration and without
          // JavaScript at all, and it keeps this whole screen a server
          // component. `open` by default — an agent opening a project wants the
          // inventory, not four closed drawers.
          <Card key={floor.floor} className="p-0">
            <details open className="group">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-2">
                  {/* Rotates to point down when the floor is open. Drawn here
                      rather than imported for the same reason as the nav
                      glyphs: one path is not a dependency. */}
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-90"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-base font-semibold text-navy-900">Floor {floor.floor}</span>
                </span>
                <span className="text-[13px] tabular-nums text-muted">
                  {floor.available} of {floor.total} available
                </span>
              </summary>

              {/* Three across below `sm:` — the mockup's grid, and the widest a
                  tile can be while still fitting a unit name on a 375px screen.
                  More columns from `sm:`, where a whole floor plate fits in one
                  band. */}
              <ul className="grid grid-cols-3 gap-2 px-4 pb-4 sm:grid-cols-4 md:grid-cols-6">
                {floor.units.map((unit) => (
                  <li key={unit.id}>
                    <UnitTile
                      href={`/projects/${project.id}/units/${unit.id}`}
                      name={unit.name}
                      bedrooms={unit.bedrooms}
                      status={unit.status}
                    />
                  </li>
                ))}
              </ul>
            </details>
          </Card>
        ))}
      </div>

      {/* One legend for the screen, beneath the grids, rather than one repeated
          under every floor: the colours mean the same thing on floor 1 as on
          floor 4, and four copies of the same three swatches is noise on a
          phone. It sits after the plate so it reads as the key to what is above
          it. */}
      <StatusLegend className="mt-4" statuses={['AVAILABLE', 'RESERVED', 'SOLD']} />
    </>
  )
}
