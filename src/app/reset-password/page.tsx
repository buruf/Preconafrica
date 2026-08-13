import Link from 'next/link'
import { Card, ErrorText } from '@/components/ui'
import { Logo } from '@/components/Logo'
import { ResetPasswordForm } from './ResetPasswordForm'

/**
 * Public — the visitor is by definition not signed in.
 *
 * A missing `?token=` is answered with the same sentence the service uses for
 * an unknown, expired or spent token. The page deliberately does not look the
 * token up before showing the form: a "this link is valid" pre-check would
 * turn the page into a token oracle that answers without ever spending
 * anything, and it would buy the honest user nothing the submit does not
 * already tell them.
 *
 * The mark and the card treatment are the login page's, for the reason set out
 * on `/forgot-password`: this is the last screen of a flow that started there
 * and ends back on login, and a step in the middle that looks like a different
 * product is the step a user abandons.
 */
const INVALID_LINK = 'This reset link is invalid or has expired.'

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export default function ResetPasswordPage({
  searchParams
}: {
  searchParams?: { token?: string | string[] }
}) {
  const token = firstParam(searchParams?.token)

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-5">
      <div className="mb-6">
        <Logo size={40} withWordmark />
        <p className="mt-3 text-[15px] text-muted">Buy early. Build the future.</p>
      </div>

      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <Card>
          <h1 className="mb-3 text-xl font-semibold text-navy-900">Choose a new password</h1>
          <ErrorText>{INVALID_LINK}</ErrorText>
          <p className="mt-3 text-[15px] text-muted">
            Ask for a new one and we will email it to you.
          </p>
        </Card>
      )}

      <Link
        href="/forgot-password"
        className="mt-2 flex min-h-11 items-center justify-center text-sm font-medium text-muted underline"
      >
        Request a new reset link
      </Link>
    </main>
  )
}
