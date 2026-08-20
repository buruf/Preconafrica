import Link from 'next/link'
import { requirePlatformAdmin } from '@/server/session'
import { Button, Card } from '@/components/ui'
import { platformSignOutAction } from '../actions'
import { PlatformPasswordForm } from './PasswordForm'

/**
 * The operator's own account: change the password, sign out.
 *
 * Both were missing when the console first shipped, which mattered more than
 * it looks — the first password an operator has is a temporary one printed to
 * a terminal, so a console with no way to replace it leaves that value live
 * indefinitely.
 */
export default async function PlatformAccountPage() {
  const actor = await requirePlatformAdmin()

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <Link
        href="/platform"
        className="inline-flex min-h-11 items-center text-sm font-semibold text-muted underline"
      >
        ← Developers
      </Link>

      <h1 className="mb-1 mt-2 text-xl font-semibold text-ink">Your account</h1>
      <p className="mb-4 text-sm text-muted">
        {actor.fullName} · {actor.email}
      </p>

      <div className="mb-4">
        <PlatformPasswordForm />
      </div>

      <Card>
        <h2 className="text-base font-semibold text-ink">Sign out</h2>
        <p className="mb-3 mt-1 text-sm text-muted">
          Ends this session on this device.
        </p>
        <form action={platformSignOutAction}>
          <Button type="submit" variant="secondary">
            Sign out
          </Button>
        </form>
      </Card>
    </main>
  )
}
