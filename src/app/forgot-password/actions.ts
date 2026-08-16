'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { RESET_TOKEN_TTL_MS } from '@/domain/password-reset'
import { resetRequestScopes } from '@/domain/rate-limit'
import { renderPasswordResetEmail } from '@/server/notifications/templates'
import { ensureEmailSender } from '@/server/notifications/resend'
import { getSender } from '@/server/notifications/sender'
import {
  RATE_LIMIT_MESSAGE,
  checkRateLimit,
  clientIp,
  recordRateLimitHit
} from '@/server/rate-limit'
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

  /**
   * The mail-bomb guard, and the second of two.
   *
   * `requestPasswordReset` already refuses a second link for the same *user*
   * inside a minute, which protects the inbox of anyone who has an account.
   * It cannot protect anything else: an unknown address never reaches that
   * check, so an attacker could still make this app do a database read, a
   * Resend round trip's worth of waiting and a 1.2-second server hold for
   * every submission they cared to send. This counter is the one that bounds
   * the request itself rather than the email it may produce.
   *
   * Counted for every accepted request, not only the ones that send mail —
   * the whole point is that the caller must not be able to tell the
   * difference, and a counter that only advanced for real accounts would say
   * out loud which addresses those are.
   *
   * The refusal is safe to show here for the same reason it is safe on the
   * login page: the counters are keyed on what was typed and where from,
   * never on what the database holds, so an unregistered address is throttled
   * on exactly the same schedule as a registered one.
   */
  const scopes = resetRequestScopes(email, clientIp())
  const gate = await checkRateLimit(scopes, new Date())
  if (!gate.allowed) {
    // Returned without the timing floor below, on purpose. The floor exists to
    // hide differences that depend on what the database said; this branch
    // never asked it anything, and whether a caller is throttled is a fact
    // about their own submissions, not about the account. Padding it would
    // only hold a serverless function open for 1.2 seconds per request an
    // attacker chooses to send — paying for the flood we are refusing.
    return RATE_LIMIT_MESSAGE
  }
  await recordRateLimitHit(scopes, new Date())

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
