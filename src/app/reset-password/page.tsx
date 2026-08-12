import Link from 'next/link'
import { Card, ErrorText } from '@/components/ui'
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
      <h1 className="mb-1 text-2xl font-semibold">Choose a new password</h1>
      <p className="mb-5 text-sm text-slate-500">
        Then sign in with it — you will not need this link again.
      </p>

      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <Card>
          <ErrorText>{INVALID_LINK}</ErrorText>
          <p className="mt-3 text-sm text-slate-600">
            Ask for a new one and we will email it to you.
          </p>
        </Card>
      )}

      <Link
        href="/forgot-password"
        className="mt-4 flex min-h-11 items-center justify-center text-sm font-medium text-slate-600 underline"
      >
        Request a new reset link
      </Link>
    </main>
  )
}
