import { redirect } from 'next/navigation'
import { Logo } from '@/components/Logo'
import { Button, Card } from '@/components/ui'
import { resolveSession } from '@/server/session'
import { signOutAction } from './actions'

/**
 * The one screen a suspended developer's staff can reach.
 *
 * It exists because of a gap that made the suspension feature dishonest: staff
 * of a suspended organisation cannot sign in, so they cannot read their own
 * audit log either — the entry recording the suspension was written somewhere
 * they could never see. They got a login screen that appeared to reject a
 * password they knew was right, with nothing to go on.
 *
 * Its guard is the mirror image of every other page's: this is the only route
 * that *requires* the outcome the rest refuse. Signed out goes to /login, and a
 * working session goes home — landing here with nothing wrong would be its own
 * kind of alarming.
 *
 * The reason is the operator's own words, shown verbatim. It is written by the
 * platform, not by another tenant, so there is no cross-tenant text here.
 */
export default async function SuspendedPage() {
  const outcome = await resolveSession()
  if (outcome.kind === 'unauthenticated') redirect('/login')
  if (outcome.kind === 'actor') redirect('/')

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-5">
      <div className="mb-6 flex flex-col items-center">
        <Logo size={40} />
      </div>

      <Card>
        <h1 className="text-xl font-semibold text-navy-900">Access suspended</h1>
        <p className="mt-2 text-sm text-muted">
          PreCon Africa has suspended your organisation&rsquo;s access, on{' '}
          {outcome.since.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC'
          })}
          .
        </p>

        {outcome.reason ? (
          <div className="mt-3 rounded-xl border border-line bg-page p-3">
            <p className="text-xs text-muted">Reason given</p>
            <p className="mt-1 text-sm text-ink">{outcome.reason}</p>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">No reason was given.</p>
        )}

        <p className="mt-3 text-sm text-muted">
          Nothing has been deleted. Your projects, sales and payment records are untouched, and
          your buyers can still sign in and download their own documents. Everything returns as
          it was when the suspension is lifted.
        </p>

        <p className="mt-3 text-sm text-muted">
          Contact PreCon Africa to resolve it.
        </p>

        <form action={signOutAction} className="mt-4">
          <Button type="submit" variant="secondary" className="w-full">
            Sign out
          </Button>
        </form>
      </Card>
    </main>
  )
}
