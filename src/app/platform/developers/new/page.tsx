import Link from 'next/link'
import { requirePlatformAdmin } from '@/server/session'
import { NewDeveloperForm } from './NewDeveloperForm'

/**
 * Guarded here, in a server component, with the client form as a child — the
 * same split every admin surface in this app uses, because a client component
 * cannot guard itself. The action behind the form guards independently.
 */
export default async function NewDeveloperPage() {
  await requirePlatformAdmin()

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <Link
        href="/platform"
        className="inline-flex min-h-11 items-center text-sm font-semibold text-muted underline"
      >
        ← Developers
      </Link>
      <h1 className="mb-1 mt-2 text-xl font-semibold text-ink">Add a developer</h1>
      <p className="mb-4 text-sm text-muted">
        Creates the organisation and the one account that can administer it.
      </p>
      <NewDeveloperForm />
    </main>
  )
}
