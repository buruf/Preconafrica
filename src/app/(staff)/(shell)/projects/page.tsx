import Link from 'next/link'
import { requireStaff } from '@/server/session'
import { listProjects } from '@/server/services/projects'
import { ButtonLink, Card, PageHeader } from '@/components/ui'

/**
 * Every building this organisation is selling.
 *
 * Restyled to DESIGN.md and nothing more: the same service call, the same rows,
 * the same ADMIN-only "New project" action. What changed is that the action is a
 * `ButtonLink` rather than a hand-rolled navy pill (it was drifting 2px from
 * every submit button in the app) and each row is a whole-card link with a 44px
 * floor, since the previous markup wrapped the card in a `Link` with no height
 * guarantee of its own.
 */
export default async function ProjectsPage() {
  const actor = await requireStaff()
  const projects = await listProjects(actor)

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle={
          projects.length === 0
            ? undefined
            : `${projects.length} project${projects.length === 1 ? '' : 's'}`
        }
        action={
          actor.role === 'ADMIN' ? (
            <ButtonLink href="/projects/new">New project</ButtonLink>
          ) : null
        }
      />

      {projects.length === 0 ? (
        <Card>
          <p className="text-[15px] text-muted">
            No projects yet.
            {actor.role === 'ADMIN' ? ' Create one to generate its units.' : ''}
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {projects.map((project) => (
            <li key={project.id}>
              {/* The whole card is the tap target — `block` plus the card's own
                  padding clears 44px comfortably at every width. */}
              <Link href={`/projects/${project.id}`} className="block">
                <Card className="transition-colors active:bg-page">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[15px] font-semibold text-navy-900">{project.name}</p>
                      <p className="text-[13px] text-muted">{project.location}</p>
                    </div>
                    <span className="shrink-0 text-[13px] font-semibold tabular-nums text-muted">
                      {project.currency}
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] tabular-nums text-muted">
                    {project._count.units} unit{project._count.units === 1 ? '' : 's'} · completing{' '}
                    {project.expectedCompletion.toISOString().slice(0, 10)}
                  </p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
