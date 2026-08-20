import Link from 'next/link'
import { prisma } from '@/server/db'
import { requirePlatformAdmin } from '@/server/session'
import { Card, ButtonLink, StatusPill } from '@/components/ui'

/**
 * Every developer on the platform, with counts and nothing else.
 *
 * The `select` below is the promise made when this was designed: projects,
 * units, buyers and sales as *numbers*. No buyer names, no amounts of money,
 * no sale rows. The platform runs the tool and is not a party to anyone's
 * sales, and a single stolen operator password should not expose every
 * developer's commercial position.
 *
 * Anyone widening this query is changing that promise and should say so out
 * loud rather than adding a field.
 */
export default async function PlatformHomePage() {
  await requirePlatformAdmin()

  const developers = await prisma.organization.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      suspendedAt: true,
      createdAt: true,
      _count: { select: { projects: true, buyers: true, sales: true, users: true } }
    },
    orderBy: { createdAt: 'desc' }
  })

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Developers</h1>
          <p className="text-sm text-muted">
            {developers.length} {developers.length === 1 ? 'developer' : 'developers'} on the platform
          </p>
        </div>
        <ButtonLink href="/platform/developers/new">Add developer</ButtonLink>
      </div>

      {developers.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">
            No developers yet. Add the first one to get them selling.
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {developers.map((dev) => (
            <li key={dev.id}>
              <Link href={`/platform/developers/${dev.id}`} className="block">
                <Card>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-base font-semibold text-ink">{dev.name}</h2>
                      <p className="text-sm text-muted">{dev.slug}</p>
                    </div>
                    {dev.suspendedAt ? (
                      <StatusPill status="OVERDUE">Suspended</StatusPill>
                    ) : (
                      <StatusPill status="AVAILABLE">Active</StatusPill>
                    )}
                  </div>
                  <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
                    {[
                      ['Projects', dev._count.projects],
                      ['Buyers', dev._count.buyers],
                      ['Sales', dev._count.sales],
                      ['Staff', dev._count.users]
                    ].map(([label, value]) => (
                      <div key={label as string}>
                        <dt className="text-xs text-muted">{label}</dt>
                        <dd className="text-base font-semibold tabular-nums text-ink">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
