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
 * database.
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

  // Outside the try, as every redirect() in this codebase is: it works by
  // throwing, and a catch block would swallow it.
  redirect('/forgot-password?sent=1')
}
