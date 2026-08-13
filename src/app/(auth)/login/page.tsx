import Link from 'next/link'
import { Logo } from '@/components/Logo'
import { LoginForm } from './LoginForm'

/**
 * The form moved into a client child so this page can stay a server component
 * and read `searchParams`. Reading them with `useSearchParams` instead would
 * have needed a Suspense boundary to keep the route buildable, for no gain.
 *
 * The notices are the other half of the two flows that end here: a password
 * change signs the user out on purpose, and landing on a bare sign-in screen
 * with no explanation reads like a failure rather than the success it is.
 *
 * This is the only page anyone sees before they have an account context, and
 * for most buyers it is the first impression of the product, so it carries the
 * mark at 40px and the tagline. It carries nothing else: there is no marketing
 * site here, and the login screen is not the place to invent one.
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
      <div className="mb-6">
        <Logo size={40} withWordmark />
        <p className="mt-3 text-[15px] text-muted">Buy early. Build the future.</p>
      </div>

      {notice ? (
        <p className="mb-4 rounded-btn border border-status-paid-border bg-status-paid-bg px-3 py-2 text-sm text-status-paid-text">
          {notice}
        </p>
      ) : null}

      <LoginForm />

      <Link
        href="/forgot-password"
        className="mt-2 flex min-h-11 items-center justify-center text-sm font-medium text-muted underline"
      >
        Forgot password?
      </Link>
    </main>
  )
}
