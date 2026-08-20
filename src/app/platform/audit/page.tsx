import { prisma } from '@/server/db'
import { requirePlatformAdmin } from '@/server/session'
import { Card } from '@/components/ui'

/**
 * What the platform operator has done, append-only and unchangeable — the
 * Postgres triggers in `prisma/audit-immutability.sql` refuse UPDATE, DELETE
 * and TRUNCATE on this table exactly as they do on the developers' own log.
 *
 * Read-only by construction: there is no action in the console that writes
 * here except through `recordPlatformAudit`, inside the transaction of the
 * thing being recorded.
 */
const SENTENCE: Record<string, (label: string) => string> = {
  'developer.created': (label) => `added the developer ${label}`,
  'developer.suspended': (label) => `suspended ${label}`,
  'developer.unsuspended': (label) => `lifted the suspension on ${label}`
}

export default async function PlatformAuditPage() {
  await requirePlatformAdmin()

  const entries = await prisma.platformAuditEntry.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200
  })

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <h1 className="text-xl font-semibold text-ink">Activity</h1>
      <p className="mb-4 text-sm text-muted">
        Platform actions, newest first. Times are UTC. This log cannot be edited or deleted.
      </p>

      {entries.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">Nothing yet.</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => {
            const label = entry.entityLabel ?? '—'
            // Falls back to the raw action rather than dropping the entry: a
            // log that hides what it cannot phrase is worse than a clumsy line.
            const said = SENTENCE[entry.action]?.(label) ?? `${entry.action} ${label}`
            return (
              <li key={entry.id}>
                <Card>
                  <p className="text-sm text-ink">
                    <span className="font-semibold">{entry.actorName}</span> {said}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {entry.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </p>
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
