import { Logo } from '@/components/Logo'
import { PlatformLoginForm } from './LoginForm'

/**
 * A separate door from /login, and separate on purpose.
 *
 * Nothing here hints that the other door exists, and nothing at /login hints
 * at this one. A developer signing in has no reason to know the platform
 * console is a thing, and an address that fails here fails identically to one
 * that was never an operator.
 *
 * There is deliberately no "forgot password" link: the recovery path for an
 * operator is `npm run platform:create-admin`, run by someone who already has
 * database access, because an emailed reset for the account that governs every
 * developer on the platform is a wider door than this needs.
 */
export default function PlatformLoginPage({
  searchParams
}: {
  searchParams?: { changed?: string | string[] }
}) {
  // A password change revokes the session that made it, so this screen is
  // where a successful change lands. Without a word of explanation it reads as
  // a failure rather than as the success it is.
  const raw = Array.isArray(searchParams?.changed)
    ? searchParams?.changed[0]
    : searchParams?.changed
  const changed = raw === '1'

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-5">
      <div className="mb-6 flex flex-col items-center">
        <Logo size={40} />
      </div>
      {changed ? (
        <p className="mb-3 rounded-xl border border-line bg-navy-100 p-3 text-sm text-ink">
          Password changed — sign in with your new password.
        </p>
      ) : null}
      <PlatformLoginForm />
    </main>
  )
}
