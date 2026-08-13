import Link from 'next/link'
import { Card } from '@/components/ui'
import { Logo } from '@/components/Logo'
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
 *
 * Styled as the login page's twin — the same mark at 40px, the same tagline, the
 * same `max-w-sm` centred column, the same card with its heading inside it. This
 * is the other half of the only public surface the product has, and it was
 * reading like a different application: no mark, `text-2xl`, stock slate greys.
 * A password-reset page that does not look like the product is also the page a
 * phishing copy is easiest to pass off.
 */
export default function ForgotPasswordPage({
  searchParams
}: {
  searchParams?: { sent?: string | string[] }
}) {
  const sent = searchParams?.sent === '1'

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-5">
      <div className="mb-6">
        <Logo size={40} withWordmark />
        <p className="mt-3 text-[15px] text-muted">Buy early. Build the future.</p>
      </div>

      {sent ? (
        <Card>
          <h1 className="mb-2 text-xl font-semibold text-navy-900">Check your email</h1>
          <p className="text-[15px] text-ink">
            If an account exists for that email, we&rsquo;ve sent a reset link. It expires in 60
            minutes.
          </p>
        </Card>
      ) : (
        <ForgotPasswordForm />
      )}

      <Link
        href="/login"
        className="mt-2 flex min-h-11 items-center justify-center text-sm font-medium text-muted underline"
      >
        Back to sign in
      </Link>
    </main>
  )
}
