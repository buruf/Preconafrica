import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/server/db'
import { requireAdmin } from '@/server/session'
import { PlanImporter } from './PlanImporter'

/**
 * The guard lives here, in a server component, and the importer below is a
 * client one. That split is not stylistic: `/projects/new` shipped as a client
 * component top to bottom and was therefore reachable by anyone who knew the
 * URL. A client component cannot guard itself.
 */
export default async function ImportPlansPage({ params }: { params: { id: string } }) {
  const actor = await requireAdmin()

  const project = await prisma.project.findFirst({
    where: { id: params.id, orgId: actor.orgId },
    select: {
      id: true,
      name: true,
      units: {
        select: { id: true, name: true, bedrooms: true, layoutImageUrl: true },
        orderBy: [{ floor: 'asc' }, { name: 'asc' }]
      }
    }
  })
  if (!project) notFound()

  return (
    <main className="p-4 sm:p-6">
      <Link
        href={`/projects/${project.id}`}
        className="inline-flex min-h-11 items-center text-sm font-semibold text-muted underline"
      >
        ← {project.name}
      </Link>

      <h1 className="mt-2 text-xl font-semibold text-ink">Import floor plans</h1>
      <p className="mt-1 text-sm text-muted">
        Choose the developer&rsquo;s PDF. It stays on this device — only the pages you pick are
        uploaded.
      </p>

      <PlanImporter
        projectId={project.id}
        units={project.units.map((unit) => ({
          id: unit.id,
          name: unit.name,
          bedrooms: unit.bedrooms,
          hasPlan: unit.layoutImageUrl !== null
        }))}
      />
    </main>
  )
}
