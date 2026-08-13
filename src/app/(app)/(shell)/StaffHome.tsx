import Link from 'next/link'
import { requireStaff } from '@/server/session'
import { staffHome } from '@/server/services/home'
import { formatMinor } from '@/domain/currency'
import { Card, MoneyPair, PageHeader, StatCard } from '@/components/ui'
import { MediaImage } from '@/components/media'

/**
 * The developer's first screen: their organisation, their buildings, and the
 * three numbers that decide what they do next.
 *
 * Server-rendered end to end. Every amount is turned into a string here by
 * `formatMinor`, in the project's own currency — no bigint reaches a client
 * component, and no float is ever constructed on the way.
 */
export async function StaffHome() {
  // Its own guard, as every page in this app has. The layout's `requireUser`
  // authenticates; this is what says staff.
  const actor = await requireStaff()
  const home = await staffHome(actor, new Date())

  return (
    <>
      <PageHeader
        title={home.organizationName}
        subtitle={
          home.projects.length === 1 ? '1 project' : `${home.projects.length} projects`
        }
      />

      {/* The three figures that start a working day: what is left to sell, what
          is being paid off, and who has stopped paying. */}
      <div className="mb-6 grid grid-cols-3 gap-3">
        <StatCard label="Units available" value={String(home.unitsAvailable)} />
        <StatCard label="Sales active" value={String(home.salesActive)} />
        <StatCard
          label="Buyers overdue"
          value={String(home.buyersOverdue)}
          tone={home.buyersOverdue > 0 ? 'bad' : 'good'}
        />
      </div>

      <h2 className="mb-3 text-base font-semibold text-navy-900">Projects</h2>

      {home.projects.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">No projects yet.</p>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {home.projects.map((project) => (
            <li key={project.id}>
              <Link href={`/projects/${project.id}`} className="block">
                <Card className="active:bg-page">
                  {/* The building first. This is the screen an agent turns
                      round to show a walk-in buyer, and the placeholder is how
                      an admin notices the photo is still missing. */}
                  <MediaImage
                    kind="building"
                    src={project.heroImageUrl}
                    alt={`${project.name}, ${project.location}`}
                  />
                  <p className="mt-3 text-[15px] font-semibold text-navy-900">{project.name}</p>
                  <p className="text-[13px] text-muted">{project.location}</p>
                  <p className="mt-2 text-[13px] tabular-nums text-muted">
                    {project.unitsAvailable} of {project.unitsTotal} units available
                  </p>
                  <MoneyPair
                    label="From"
                    className="mt-1"
                    value={
                      project.fromPriceMinor === null
                        ? 'Sold out'
                        : formatMinor(project.fromPriceMinor, project.currency)
                    }
                  />
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
