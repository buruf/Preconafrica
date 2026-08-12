import Link from 'next/link'
import { Card } from '@/components/ui'
import { ForgotPasswordForm } from './ForgotPasswordForm'

/**
 * Public — no guard, by design: someone who cannot sign in is exactly who
 * needs this page.
 *
 * The confirmation is a server-rendered state driven by `?sent=1` rather than
 * form state, so that the action can reach it by redirect and every outcome
 * (unknown address, deactivated account, throttled request, real link sent,
 * mail provider down) lands on byte-identical text. Nothing here is
 * conditional on anything the database said.
 */
export default function ForgotPasswordPage({
  searchParams
}: {
  searchParams?: { sent?: string | string[] }
}) {
  const sent = searchParams?.sent === '1'

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-5">
      <h1 className="mb-1 text-2xl font-semibold">Reset your password</h1>
      <p className="mb-5 text-sm text-slate-500">
        {sent
          ? 'Check your email.'
          : 'Enter the email address you sign in with and we will send you a link.'}
      </p>

      {sent ? (
        <Card>
          <p className="text-sm text-slate-700">
            If an account exists for that email, we&rsquo;ve sent a reset link. It expires in 60
            minutes.
          </p>
        </Card>
      ) : (
        <ForgotPasswordForm />
      )}

      <Link
        href="/login"
        className="mt-4 flex min-h-11 items-center justify-center text-sm font-medium text-slate-600 underline"
      >
        Back to sign in
      </Link>
    </main>
  )
}
