'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { RESET_TOKEN_TTL_MS } from '@/domain/password-reset'
import { renderPasswordResetEmail } from '@/server/notifications/templates'
import { ensureEmailSender } from '@/server/notifications/resend'
import { getSender } from '@/server/notifications/sender'
import { requestPasswordReset } from '@/server/services/passwords'

const EmailSchema = z.string().trim().toLowerCase().email('Enter a valid email address')

/**
 * How long this action takes, on every path, no matter what happened inside.
 *
 * Identical wording is not identical behaviour. A real, unthrottled address
 * awaits an HTTPS round trip to Resend; an unknown address returns after one
 * indexed read, and a throttled one after two. The page said the same thing in
 * all three cases and took visibly different amounts of time to say it, which
 * is an enumeration oracle with an extra fact attached: a fast answer for an
 * address that was slow a minute ago means "that account exists and someone
 * just asked for a reset".
 *
 * The obvious fix — stop awaiting the send — was rejected. This app deploys to
 * Vercel (see vercel.json), where a serverless function may be frozen the
 * moment its response is written; an un-awaited promise then resolves on the
 * next invocation that happens to thaw the same instance, or never. There is
 * no `waitUntil` in this project's dependencies to hand the promise to. That
 * trades a timing oracle for silently undelivered reset emails, which is the
 * worse bug by some distance: a user who never receives the link has no path
 * back into their account, and nothing anywhere reports it.
 *
 * So the send is still awaited and the floor is imposed instead. 1200ms sits
 * above the send path's p99 (a Resend call from a warm Vercel function is
 * comfortably inside a few hundred milliseconds, and the two database reads in
 * front of it are single-digit), so the wait is what dominates every outcome
 * and the differences disappear underneath it. It costs a real user a little
 * over a second on a form they submit once.
 */
const RESPONSE_FLOOR_MS = 1200

/**
 * Sleep out whatever is left of the budget. Measured from before the first
 * database read, so it covers the whole request, not just the send.
 */
function awaitFloor(startedAt: number): Promise<void> {
  const remaining = RESPONSE_FLOOR_MS - (Date.now() - startedAt)
  if (remaining <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, remaining))
}

/**
 * Every path through this action ends at the same confirmation page.
 *
 * That is the whole design. A form that answers differently for a registered
 * address than for an unregistered one is a free account-enumeration API, and
 * the differences are easy to introduce by accident: an error boundary for a
 * database hiccup that can only happen once a user was found, a "we could not
 * send that email" message that only a real recipient can trigger. So the
 * failures are swallowed and logged rather than surfaced, and the redirect
 * happens unconditionally.
 *
 * The only thing this returns is a malformed-email complaint, which reveals
 * nothing — whether "not-an-email" is a valid address is not a fact about this
 * database. It is also the one path that skips the timing floor below, for the
 * same reason: it is already distinguishable by what it returns, so padding it
 * would buy nothing and make a typo take a second to report.
 */
export async function requestPasswordResetAction(
  _prev: string | undefined,
  formData: FormData
) {
  const parsed = EmailSchema.safeParse(String(formData.get('email') ?? ''))
  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? 'Enter a valid email address.'
  }

  const email = parsed.data
  // Started before the first read, so the floor covers every branch below
  // rather than only the one that sends mail.
  const startedAt = Date.now()

  try {
    const { resetUrl, fullName } = await requestPasswordReset(email, new Date())

    if (resetUrl) {
      // RESEND_API_KEY is empty in local development, so ensureEmailSender()
      // throws and no mail is ever sent — which would make the whole flow
      // untestable without a mail provider. Logging the link keeps it
      // testable. The guard is on NODE_ENV, which Next sets to 'production'
      // in every production build, so this branch cannot run there and print
      // a live credential into a log aggregator.
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[dev] password reset link for ${email}: ${resetUrl}`)
      }

      try {
        ensureEmailSender()
        const message = renderPasswordResetEmail({
          fullName: fullName ?? '',
          resetUrl,
          expiresInMinutes: RESET_TOKEN_TTL_MS / 60_000
        })
        await getSender('EMAIL').send({ destination: email, ...message })
      } catch (error) {
        // A send failure must not change what the requester sees: "we could
        // not deliver that" is only ever true for an address that exists.
        console.error('[password-reset] could not send the reset email', error)
      }
    }
  } catch (error) {
    console.error('[password-reset] could not process the reset request', error)
  }

  // Every outcome that got this far leaves at the same moment. Deliberately
  // after the catch, so a thrown request is padded exactly like a successful
  // one — an error that only a real account can produce would otherwise be the
  // fastest path of all.
  await awaitFloor(startedAt)

  // Outside the try, as every redirect() in this codebase is: it works by
  // throwing, and a catch block would swallow it.
  redirect('/forgot-password?sent=1')
}
