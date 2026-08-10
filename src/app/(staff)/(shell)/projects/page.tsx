import Link from 'next/link'
import { requireStaff } from '@/server/session'
import { listProjects } from '@/server/services/projects'
import { Card, PageHeader } from '@/components/ui'

export default async function ProjectsPage() {
  const actor = await requireStaff()
  const projects = await listProjects(actor)

  return (
    <>
      <PageHeader
        title="Projects"
        action={
          actor.role === 'ADMIN' ? (
            <Link
              href="/projects/new"
              className="flex min-h-11 items-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white"
            >
              New project
            </Link>
          ) : null
        }
      />

      {projects.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">No projects yet.</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {projects.map((project) => (
            <li key={project.id}>
              <Link href={`/projects/${project.id}`}>
                <Card className="active:bg-slate-50">
                  <p className="font-medium">{project.name}</p>
                  <p className="text-sm text-slate-500">{project.location}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    {project._count.units} units · {project.currency} · completing{' '}
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
