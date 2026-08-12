import Link from 'next/link'
import { LoginForm } from './LoginForm'

/**
 * The form moved into a client child so this page can stay a server component
 * and read `searchParams`. Reading them with `useSearchParams` instead would
 * have needed a Suspense boundary to keep the route buildable, for no gain.
 *
 * The notices are the other half of the two flows that end here: a password
 * change signs the user out on purpose, and landing on a bare sign-in screen
 * with no explanation reads like a failure rather than the success it is.
 */
const NOTICES: Record<string, string> = {
  reset: 'Password updated — sign in with your new password.',
  changed: 'Password changed — sign in with your new password.'
}

function isSet(value: string | string[] | undefined): boolean {
  return (Array.isArray(value) ? value[0] : value) === '1'
}

export default function LoginPage({
  searchParams
}: {
  searchParams?: { reset?: string | string[]; changed?: string | string[] }
}) {
  const notice = isSet(searchParams?.reset)
    ? NOTICES.reset
    : isSet(searchParams?.changed)
      ? NOTICES.changed
      : undefined

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-5">
      <h1 className="mb-1 text-2xl font-semibold">Sign in</h1>
      <p className="mb-5 text-sm text-slate-500">Developers, agents and buyers.</p>

      {notice ? (
        <p className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>
      ) : null}

      <LoginForm />

      <Link
        href="/forgot-password"
        className="mt-4 flex min-h-11 items-center justify-center text-sm font-medium text-slate-600 underline"
      >
        Forgot password?
      </Link>
    </main>
  )
}
