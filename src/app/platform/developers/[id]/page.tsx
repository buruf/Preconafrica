import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/server/db'
import { requirePlatformAdmin } from '@/server/session'
import { Card, StatusPill } from '@/components/ui'
import { SuspendButton } from './SuspendButton'
import { DeleteButton } from './DeleteButton'

/**
 * One developer: counts, status, and the suspend control.
 *
 * The `select` is again the whole point. `_count` gives numbers without ever
 * loading a row, so this page cannot accidentally render a buyer's name or an
 * amount of money — the shape of the query is what enforces the promise, not
 * the care taken by whoever writes the JSX below it.
 */
export default async function DeveloperPage({ params }: { params: { id: string } }) {
  await requirePlatformAdmin()

  const dev = await prisma.organization.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      name: true,
      slug: true,
      suspendedAt: true,
      createdAt: true,
      _count: {
        select: {
          projects: true,
          buyers: true,
          sales: true,
          users: true,
          // Not displayed — read only to decide whether deleting is offered.
          // The same five counts the service checks, so the button appears
          // exactly when the action would succeed.
          payments: true,
          documents: true
        }
      }
    }
  })
  if (!dev) notFound()

  const counts: Array<[string, number]> = [
    ['Projects', dev._count.projects],
    ['Buyers', dev._count.buyers],
    ['Sales', dev._count.sales],
    ['Staff accounts', dev._count.users]
  ]

  // Staff are excluded on purpose: a developer always has the admin created
  // alongside it, so counting them would make nothing ever deletable.
  const isEmpty =
    dev._count.projects === 0 &&
    dev._count.buyers === 0 &&
    dev._count.sales === 0 &&
    dev._count.payments === 0 &&
    dev._count.documents === 0

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <Link
        href="/platform"
        className="inline-flex min-h-11 items-center text-sm font-semibold text-muted underline"
      >
        ← Developers
      </Link>

      <div className="mb-4 mt-2 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">{dev.name}</h1>
          <p className="text-sm text-muted">
            {dev.slug} · joined{' '}
            {dev.createdAt.toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC'
            })}
          </p>
        </div>
        {dev.suspendedAt ? (
          <StatusPill status="OVERDUE">Suspended</StatusPill>
        ) : (
          <StatusPill status="AVAILABLE">Active</StatusPill>
        )}
      </div>

      <Card className="mb-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {counts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="text-xl font-bold tabular-nums text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted">
          Counts only. This console does not show a developer&rsquo;s buyers, sales or payments.
        </p>
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-ink">Access</h2>
        <p className="mb-3 mt-1 text-sm text-muted">
          {dev.suspendedAt
            ? 'Their staff cannot sign in. Their buyers still can, and nothing has been deleted.'
            : 'Suspending signs their staff out on their next action. Their buyers keep the documents they already hold.'}
        </p>
        <SuspendButton
          orgId={dev.id}
          developerName={dev.name}
          suspended={dev.suspendedAt !== null}
        />
      </Card>

      {/* Only for a developer with nothing in it — a mistyped one, in other
          words. Anything with real data is suspended and never deleted, so the
          control is absent rather than present-and-refusing: an operator should
          not have to discover the rule by tripping over it. */}
      {isEmpty ? (
        <Card className="mt-4">
          <h2 className="text-base font-semibold text-ink">Delete</h2>
          <p className="mb-3 mt-1 text-sm text-muted">
            {dev.name} has no projects, buyers or sales, so it can still be removed — useful if
            the name or short name was typed wrong. Once it has data, this option disappears and
            suspending is the only way to stop it.
          </p>
          <DeleteButton orgId={dev.id} developerName={dev.name} />
        </Card>
      ) : null}
    </main>
  )
}
